import * as vscode from "vscode";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionStore } from "../state/session-store";
import type { HostMessage } from "../shared/bridge";
import type {
  ResourceAction,
  ResourceItem,
  ResourceKind,
  ResourceOperation,
  ResourceScope,
  ResourceSnapshot,
} from "../shared/resources";
import { resolvePiLaunch, assertWorkspace } from "../pi/launcher";
import {
  agentDirectory,
  agentSkillRoots,
  configPath,
  discoverLocalResources,
  exactResourceRule,
  exactRuleState,
  isRecord,
  packageCliSource,
  patchResourceConfig,
  readResourceConfig,
  resolveResourcePath,
  resourcePaths,
  validateMcpName,
  validatePackageSource,
  type ResourceConfig,
} from "./resource-config";

interface Entry {
  view: ResourceItem;
  config: ResourceConfig;
  target: string;
  index?: number;
  source?: string;
  packageResource?: boolean;
}
const scopeLabel = (scope: ResourceScope) =>
  scope === "user" ? "用户级" : "当前项目";
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Owns configuration operations; model execution and resource loading remain in PI. */
export class ResourceService implements vscode.Disposable {
  private entries = new Map<string, Entry>();
  private snapshot?: ResourceSnapshot;
  private workspace?: string;
  private busy = false;
  private refreshRevision = 0;
  private reveal = false;
  private pending = false;
  private configRevision = 0;
  private disposed = false;
  private tasks = new Map<vscode.TaskExecution, string>();
  private startingTask = false;
  private launchAbort?: AbortController;
  private earlyTaskEnds = new Map<vscode.TaskExecution, number | undefined>();
  private refreshAfterTask = false;
  private subscriptions: vscode.Disposable[];
  constructor(
    private store: SessionStore,
    private post: (message: HostMessage) => void,
    private apply: (workspace: string) => Promise<void>,
  ) {
    this.subscriptions = [
      {
        dispose: store.subscribe(() => {
          if (this.snapshot && this.snapshot.canApply !== this.canApply())
            this.publish();
        }, [
          "run",
          "connection",
          "shell",
          "queues",
          "compaction",
          "queueControl",
        ]),
      },
      vscode.tasks.onDidEndTaskProcess((event) =>
        this.endTask(event.execution, event.exitCode),
      ),
      vscode.tasks.onDidEndTask((event) => this.endTask(event.execution)),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (!this.workspace) return;
        const file = document.uri.fsPath;
        const known = ["user", "project"].some((scope) =>
          [true, false].some(
            (mcp) =>
              configPath(
                this.workspace!,
                agentDirectory(),
                scope as ResourceScope,
                mcp,
              ) === file,
          ),
        );
        if (
          known ||
          [...this.entries.values()].some((entry) => entry.target === file)
        ) {
          this.markPending();
          this.publish();
        }
      }),
    ];
  }
  private endTask(execution: vscode.TaskExecution, exitCode?: number) {
    const operation = this.tasks.get(execution);
    if (this.disposed) return;
    if (!operation) {
      if (this.startingTask && !this.earlyTaskEnds.has(execution))
        this.earlyTaskEnds.set(execution, exitCode);
      return;
    }
    this.tasks.delete(execution);
    if (
      ["install", "remove", "update", "updateAll", "configure"].includes(
        operation,
      )
    )
      this.markPending();
    if (this.snapshot) {
      this.snapshot.notice = `PI CLI ${operation} 已结束，退出码 ${exitCode ?? "未知"}。详情见任务终端；配置列表不代表当前进程已加载。`;
      if (!this.busy) void this.refresh().catch(() => this.publish());
      else {
        this.refreshAfterTask = true;
        this.publish();
      }
    }
  }
  dispose() {
    this.disposed = true;
    this.launchAbort?.abort();
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const execution of this.tasks.keys()) execution.terminate();
    this.tasks.clear();
  }
  show() {
    this.reveal = true;
    return this.handle({
      type: "resourceAction",
      operation: "refresh",
      kind: "mcp",
      scope: "project",
    });
  }
  private canApply() {
    const state = this.store.getSnapshot();
    return (
      state.connection !== "connecting" &&
      state.run === "idle" &&
      !state.compaction.active &&
      !state.shell?.active &&
      !state.queueControl?.busy &&
      !state.queues.steering.length &&
      !state.queues.followUp.length &&
      !this.tasks.size
    );
  }
  private publish() {
    if (this.snapshot && !this.disposed) {
      this.snapshot.canApply = this.canApply();
      this.post({
        type: "resources",
        state: {
          ...this.snapshot,
          busy: this.busy,
          pending: this.pending,
          canApply: this.canApply(),
        },
        reveal: this.reveal,
      });
      this.reveal = false;
    }
  }
  private markPending() {
    this.pending = true;
    this.configRevision++;
  }
  private assertActiveWorkspace() {
    if (this.disposed) throw new Error("资源管理已关闭。");
    this.assertLocal();
    const current = this.store.getSnapshot().workspace;
    if (current && current !== this.workspace)
      throw new Error("PI 工作目录已改变，请刷新资源列表后重试。");
    if (
      !vscode.workspace.workspaceFolders?.some(
        (folder) => folder.uri.fsPath === this.workspace,
      )
    )
      throw new Error("工作区已关闭，请重新打开资源管理。");
  }
  private assertLocal() {
    assertWorkspace({
      trusted: vscode.workspace.isTrusted,
      remote: !!vscode.env.remoteName,
      uri: this.workspace
        ? vscode.Uri.file(this.workspace).toString()
        : undefined,
    });
  }
  private async selectWorkspace() {
    const state = this.store.getSnapshot();
    const folders = vscode.workspace.workspaceFolders;
    let selected =
      state.workspace &&
      folders?.some((folder) => folder.uri.fsPath === state.workspace)
        ? state.workspace
        : this.workspace;
    if (
      !selected ||
      !folders?.some((folder) => folder.uri.fsPath === selected)
    ) {
      const folder =
        folders?.length === 1
          ? folders[0]
          : await vscode.window.showWorkspaceFolderPick({
              placeHolder: "选择 PI 资源管理的项目目录",
            });
      if (!folder) throw new Error("请先选择一个本地工作区目录。");
      selected = assertWorkspace({
        trusted: vscode.workspace.isTrusted,
        remote: !!vscode.env.remoteName,
        uri: folder.uri.toString(),
      });
    }
    this.workspace = selected;
    this.assertLocal();
  }
  async handle(action: ResourceAction): Promise<void> {
    if (this.busy || this.disposed) return;
    this.refreshRevision++;
    this.busy = true;
    this.publish();
    try {
      if (
        action.operation !== "refresh" &&
        this.snapshot &&
        this.store.getSnapshot().workspace &&
        this.store.getSnapshot().workspace !== this.snapshot.workspace
      )
        throw new Error("PI 工作目录已改变，请刷新资源列表后重试。");
      await this.selectWorkspace();
      if (!this.snapshot || this.snapshot.workspace !== this.workspace)
        await this.refresh();
      this.snapshot!.error = undefined;
      this.snapshot!.notice = undefined;
      const entry = action.id ? this.entries.get(action.id) : undefined;
      if (
        action.id &&
        (!entry ||
          entry.view.kind !== action.kind ||
          entry.view.scope !== action.scope ||
          !entry.view.actions.includes(action.operation))
      )
        throw new Error("资源列表已经改变，请刷新后重试。");
      if (
        this.tasks.size &&
        !["refresh", "open", "edit", "openConfig"].includes(action.operation)
      )
        throw new Error(
          "请先在任务终端结束当前 PI 资源管理命令，再修改配置或运行其他命令。",
        );
      if (action.operation === "refresh") await this.refresh();
      else if (action.operation === "openConfig")
        await this.openConfig(
          configPath(
            this.workspace!,
            agentDirectory(),
            action.scope,
            action.kind === "mcp",
          ),
        );
      else if (action.operation === "addMcp" && action.kind === "mcp")
        await this.addMcp(action.scope);
      else if (action.operation === "createSkill" && action.kind === "skills")
        await this.createSkill(action.scope);
      else if (
        action.operation === "addPath" &&
        ["skills", "extensions"].includes(action.kind)
      )
        await this.addPath(
          action.scope,
          action.kind as "skills" | "extensions",
        );
      else if (action.operation === "install") {
        const source = await vscode.window.showInputBox({
          title: `安装 PI 包 · ${scopeLabel(action.scope)}`,
          prompt:
            "支持 npm:、git:、仓库 URL 或绝对本地路径。相对路径按当前项目目录解析。",
          placeHolder: "npm:@scope/pi-package@1.0.0",
          validateInput: validatePackageSource,
          ignoreFocusOut: true,
        });
        if (source && validatePackageSource(source))
          throw new Error(validatePackageSource(source));
        if (source)
          await this.cli("install", [
            "install",
            source,
            ...(action.scope === "project" ? ["--local"] : []),
          ]);
      } else if (action.operation === "configure")
        await this.cli("configure", [
          "config",
          ...(action.scope === "project" ? ["--local"] : []),
        ]);
      else if (action.operation === "diagnose")
        await this.cli("diagnose", ["mcp", "list"]);
      else if (action.operation === "listPackages")
        await this.cli("listPackages", ["list"]);
      else if (action.operation === "updateAll")
        await this.cli("updateAll", ["update", "--extensions"]);
      else if (action.operation === "apply") {
        if (!this.canApply())
          throw new Error(
            "请等待任务、压缩、独立命令、队列和资源管理终端操作结束，再重新连接应用配置。",
          );
        if (
          this.store.getSnapshot().workspace &&
          this.store.getSnapshot().workspace !== this.workspace
        )
          throw new Error(
            "资源管理目录与当前 PI 工作目录不同，请重新打开资源管理。",
          );
        const revision = this.configRevision;
        await this.apply(this.workspace!);
        this.pending = revision !== this.configRevision;
        this.snapshot!.notice = this.pending
          ? "已重新连接 PI；重连期间仍有配置变更，请再次重新连接应用。"
          : "已重新连接 PI 并尝试恢复当前会话。资源是否加载成功以 PI 返回的命令和诊断为准。";
        await this.refresh();
      } else if (entry) {
        if (action.operation === "open") {
          if (entry.target.startsWith("builtin:"))
            throw new Error("PI 内置扩展没有可编辑的本地来源文件。");
          await this.openSource(entry.target);
        } else if (action.operation === "edit")
          await this.openConfig(entry.config.path);
        else if (action.operation === "toggle") await this.toggle(entry);
        else if (action.operation === "exposure") await this.exposure(entry);
        else if (action.operation === "projectOverride")
          await this.projectOverride(entry);
        else if (action.operation === "filters") await this.filters(entry);
        else if (action.operation === "remove") await this.remove(entry);
        else if (action.operation === "update" && entry.source)
          await this.cli("update", [
            "update",
            "--extension",
            packageCliSource(entry.source, entry.config),
          ]);
        else if (
          ["login", "logout"].includes(action.operation) &&
          entry.view.kind === "mcp"
        ) {
          if (validateMcpName(entry.target))
            throw new Error("MCP 名称无效，请修复配置后重试。");
          await this.cli(action.operation, [
            "mcp",
            action.operation,
            entry.target,
            ...(entry.view.scope === "project" ? ["-l"] : []),
          ]);
        } else throw new Error("此资源不支持该操作。");
      } else throw new Error("不支持的资源管理操作。");
    } catch (error) {
      if (this.snapshot) this.snapshot.error = errorText(error);
      else void vscode.window.showErrorMessage(errorText(error));
    } finally {
      try {
        if (this.refreshAfterTask && !this.disposed) {
          this.refreshAfterTask = false;
          await this.refresh();
        }
      } catch (error) {
        if (this.snapshot) this.snapshot.error = errorText(error);
      } finally {
        this.busy = false;
        this.publish();
      }
    }
  }
  private async refresh() {
    const revision = ++this.refreshRevision;
    this.assertLocal();
    const workspace = this.workspace!;
    const agentDir = agentDirectory();
    const old = this.snapshot;
    const warnings: string[] = [];
    const entries = new Map<string, Entry>();
    const add = (
      entry: Omit<Entry, "view"> & { view: Omit<ResourceItem, "id"> },
    ) => {
      if (entries.size >= 700) {
        if (!warnings.includes("插件列表限制：最多展示 700 项。"))
          warnings.push("插件列表限制：最多展示 700 项。");
        return;
      }
      const id = randomUUID();
      const view = {
        ...entry.view,
        name:
          entry.view.name.length > 500
            ? `${entry.view.name.slice(0, 500)}…`
            : entry.view.name,
        detail:
          entry.view.detail.length > 1000
            ? `${entry.view.detail.slice(0, 1000)}…`
            : entry.view.detail,
      };
      if (
        (view.name !== entry.view.name || view.detail !== entry.view.detail) &&
        !warnings.includes("插件预览限制：部分资源名称或说明已截断。")
      )
        warnings.push("插件预览限制：部分资源名称或说明已截断。");
      entries.set(id, { ...entry, view: { ...view, id } });
    };
    const configs = new Map<string, ResourceConfig>();
    for (const scope of ["user", "project"] as const) {
      for (const mcp of [false, true]) {
        const file = configPath(workspace, agentDir, scope, mcp);
        try {
          configs.set(file, await readResourceConfig(file));
        } catch {
          warnings.push(`${file}：配置无法读取或 JSON 无效，请打开配置修复。`);
        }
      }
    }
    const userMcp = configs.get(configPath(workspace, agentDir, "user", true));
    const projectMcp = configs.get(
      configPath(workspace, agentDir, "project", true),
    );
    for (const scope of ["user", "project"] as const) {
      const mcpConfig = scope === "user" ? userMcp : projectMcp;
      if (mcpConfig) {
        const servers = mcpConfig.value.mcpServers;
        if (servers !== undefined && !isRecord(servers))
          warnings.push(`${mcpConfig.path}：mcpServers 必须是对象。`);
        if (isRecord(servers))
          for (const [name, server] of Object.entries(servers)) {
            const valid = isRecord(server);
            const inherited =
              scope === "project" &&
              valid &&
              !server.command &&
              !server.url &&
              !server.type;
            const base =
              inherited &&
              isRecord(userMcp?.value.mcpServers) &&
              isRecord(userMcp.value.mcpServers[name])
                ? userMcp.value.mcpServers[name]
                : {};
            const effective = valid ? { ...base, ...server } : {};
            const overridden =
              scope === "user" &&
              isRecord(projectMcp?.value.mcpServers) &&
              Object.hasOwn(projectMcp.value.mcpServers, name);
            const invalid = !valid || !!validateMcpName(name);
            add({
              config: mcpConfig,
              target: name,
              view: {
                kind: "mcp",
                scope,
                name,
                path: mcpConfig.path,
                detail: `${inherited ? "项目覆盖 · " : ""}${effective.command ? "stdio" : effective.url ? "HTTP" : "连接配置不完整"} · exposure: ${typeof effective.exposure === "string" && ["direct", "deferred", "codemode", "codemode-deferred", "hidden"].includes(effective.exposure) ? effective.exposure : "默认 codemode"}${overridden ? " · 存在项目覆盖" : ""}`,
                state: invalid
                  ? "配置无效"
                  : effective.enabled === false
                    ? "配置已禁用"
                    : "配置已启用",
                actions: invalid
                  ? ["edit", "remove"]
                  : [
                      "edit",
                      "toggle",
                      "exposure",
                      ...(scope === "user" ? ["projectOverride" as const] : []),
                      "login",
                      "logout",
                      "remove",
                    ],
              },
            });
          }
      }
      const config = configs.get(configPath(workspace, agentDir, scope));
      if (!config) continue;
      const packages = config.value.packages;
      if (packages !== undefined && !Array.isArray(packages))
        warnings.push(`${config.path}：packages 必须是数组。`);
      if (Array.isArray(packages))
        packages.forEach((pkg, index) => {
          const source =
            typeof pkg === "string"
              ? pkg
              : isRecord(pkg) && typeof pkg.source === "string"
                ? pkg.source
                : undefined;
          if (!source || validatePackageSource(source)) {
            warnings.push(
              `${scopeLabel(scope)}第 ${index + 1} 个包声明无效，请打开 settings.json 修复。`,
            );
            return;
          }
          const filters = isRecord(pkg)
            ? ["extensions", "skills", "prompts", "themes"]
                .filter((key) => Array.isArray(pkg[key]))
                .map(
                  (key) =>
                    `${key}: ${(pkg[key] as unknown[]).length === 0 ? "不加载" : "已筛选"}`,
                )
                .join(" · ")
            : "";
          add({
            config,
            target: config.path,
            source,
            index,
            view: {
              kind: "packages",
              scope,
              name: source,
              detail: filters || "按 PI 包声明加载资源",
              state:
                isRecord(pkg) && pkg.autoload === false
                  ? "项目过滤增量"
                  : "已配置包",
              path: config.path,
              actions: ["edit", "filters", "update", "remove"],
            },
          });
        });
      for (const kind of ["skills", "extensions"] as const) {
        let values: string[];
        try {
          values = resourcePaths(config, kind);
        } catch (error) {
          warnings.push(errorText(error));
          continue;
        }
        const roots = [
          path.join(
            scope === "user" ? agentDir : path.join(workspace, ".pi"),
            kind,
          ),
        ];
        if (kind === "skills") {
          const agentRoots = await agentSkillRoots(workspace);
          roots.push(
            ...(scope === "user"
              ? agentRoots.slice(0, 1)
              : agentRoots.slice(1)),
          );
        }
        for (const value of values) {
          if (
            /^[!+-]/.test(value) ||
            /[*?]/.test(value) ||
            value.startsWith("builtin:")
          )
            continue;
          roots.push(resolveResourcePath(value, config));
        }
        try {
          const result = await discoverLocalResources(roots, kind);
          warnings.push(...result.warnings);
          if (result.truncated)
            warnings.push(
              `${scopeLabel(scope)} ${kind} 本地扫描已截断（插件限制：1500 个节点、10 层、300 项）。`,
            );
          for (const resource of result.items) {
            const manifest =
              kind === "extensions" &&
              path.basename(resource.path) === "package.json";
            const target = resource.path;
            const rule = manifest
              ? undefined
              : exactRuleState(config, kind, target);
            add({
              config,
              target,
              view: {
                kind,
                scope,
                name: resource.name,
                path: resource.path,
                detail: manifest
                  ? "本地扩展清单；通过 PI 配置终端管理实际入口的启用规则"
                  : "本地发现；是否成功加载由 PI 决定",
                state:
                  rule === false
                    ? "精确规则已禁用"
                    : rule === true
                      ? "精确规则已启用"
                      : "按 PI 规则加载",
                actions: manifest
                  ? ["open", "edit"]
                  : ["open", "edit", "toggle"],
              },
            });
          }
        } catch {
          warnings.push(`${scopeLabel(scope)} ${kind} 的部分目录无法读取。`);
        }
        // Preserve and expose path/glob rules without pretending to reimplement PI filtering.
        values.forEach((rule, index) => {
          if (rule.startsWith("builtin:") || /^[+-]builtin:/.test(rule)) return;
          add({
            config,
            target: config.path,
            index,
            view: {
              kind,
              scope,
              name: rule,
              detail: "settings.json 中的路径或过滤规则",
              path: config.path,
              state: "配置规则",
              actions: ["edit", "remove"],
            },
          });
        });
        if (kind === "extensions")
          for (const name of ["mcp", "llama.cpp", "codemode", "tool-search"]) {
            const target = `builtin:${name}`;
            const rule = exactRuleState(config, kind, target, scope);
            add({
              config,
              target,
              view: {
                kind,
                scope,
                name: target,
                detail: "PI 1.5.2 内置扩展；项目规则可覆盖用户规则",
                state:
                  rule === false
                    ? "精确规则已禁用"
                    : rule === true
                      ? "精确规则已启用"
                      : "默认加载／继承",
                actions: ["edit", "toggle"],
              },
            });
          }
      }
    }
    for (const command of this.store.getSnapshot().commands) {
      if (!["skill", "extension"].includes(command.source)) continue;
      const kind = command.source === "skill" ? "skills" : "extensions";
      const scope = command.sourceInfo?.scope === "user" ? "user" : "project";
      const source = command.sourceInfo?.path;
      const existing =
        source &&
        [...entries.values()].find(
          (entry) => entry.view.kind === kind && entry.view.path === source,
        );
      if (existing) {
        existing.view.detail = `PI 当前命令：/${command.name}`;
        continue;
      }
      const config = configs.get(configPath(workspace, agentDir, scope));
      if (!config) continue;
      const safeSource =
        source && path.isAbsolute(source) && !/[\u0000-\u001f]/.test(source)
          ? source
          : undefined;
      add({
        config,
        target: safeSource || config.path,
        packageResource: true,
        view: {
          kind,
          scope,
          name: `/${command.name}`,
          detail: `PI 返回的命令来源${command.sourceInfo?.origin === "package" ? " · 包资源请通过包过滤管理" : ""}`,
          path: safeSource,
          state: "当前命令可发现",
          actions: safeSource ? ["open", "edit"] : ["edit"],
        },
      });
    }
    if (this.disposed || revision !== this.refreshRevision) return;
    this.entries = entries;
    this.snapshot = {
      workspace,
      agentDir,
      items: [...entries.values()].map((entry) => entry.view),
      warnings,
      busy: this.busy,
      pending: this.pending,
      canApply: this.canApply(),
      notice: old?.notice,
      error: old?.error,
    };
    this.publish();
  }
  private async save(
    config: ResourceConfig,
    keys: (string | number)[],
    value: unknown,
  ) {
    this.assertActiveWorkspace();
    const fresh = await readResourceConfig(config.path);
    if (fresh.text !== config.text)
      throw new Error("配置已被其他操作修改，请刷新后重试。");
    const uri = vscode.Uri.file(config.path);
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString(),
    );
    if (openDocument?.isDirty)
      throw new Error("配置在编辑器中有未保存修改，请先保存或撤销后刷新。");
    const text = patchResourceConfig(config, keys, value);
    this.assertActiveWorkspace();
    await mkdir(path.dirname(config.path), { recursive: true });
    this.assertActiveWorkspace();
    try {
      await writeFile(config.path, "{}\n", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isDirty || document.getText() !== (config.text || "{}\n"))
      throw new Error("配置内容已改变，请保存并刷新后重试。");
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      ),
      text,
    );
    this.assertActiveWorkspace();
    if (!(await vscode.workspace.applyEdit(edit)))
      throw new Error("无法应用配置修改。");
    this.markPending();
    if (!(await document.save()))
      throw new Error("配置尚未保存，请在编辑器中保存后重连。");
    this.snapshot!.notice =
      "配置已保存；空闲后点击“重新连接并应用”使当前 PI 进程重新加载。";
    await this.refresh();
  }
  private async openConfig(file: string) {
    this.assertActiveWorkspace();
    await mkdir(path.dirname(file), { recursive: true });
    this.assertActiveWorkspace();
    try {
      await writeFile(file, "{}\n", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await this.openSource(file);
    this.snapshot!.notice =
      "已在编辑器打开配置；保存后刷新列表，并在空闲时重新连接应用。";
  }
  private async openSource(file: string) {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(file),
    );
    await vscode.window.showTextDocument(document, { preview: false });
  }
  private async addMcp(scope: ResourceScope) {
    const config = await readResourceConfig(
      configPath(this.workspace!, agentDirectory(), scope, true),
    );
    if (
      config.value.mcpServers !== undefined &&
      !isRecord(config.value.mcpServers)
    )
      throw new Error("请先修复 mcpServers 对象。");
    const servers = isRecord(config.value.mcpServers)
      ? config.value.mcpServers
      : {};
    const name = await vscode.window.showInputBox({
      title: `添加 MCP · ${scopeLabel(scope)}`,
      prompt: "服务器名称",
      validateInput: (value) =>
        validateMcpName(value) ||
        (Object.keys(servers).some(
          (key) => key.replaceAll("-", "_") === value.replaceAll("-", "_"),
        )
          ? "同名或规范化后同名的服务器已存在。"
          : undefined),
      ignoreFocusOut: true,
    });
    if (!name) return;
    const transport = await vscode.window.showQuickPick(
      [
        { label: "stdio", description: "运行本地 MCP 命令" },
        { label: "HTTP", description: "连接 streamable HTTP MCP" },
      ],
      { title: "MCP 连接方式" },
    );
    if (!transport) return;
    const server: Record<string, unknown> = {};
    if (transport.label === "stdio") {
      const command = await vscode.window.showInputBox({
        title: "MCP 可执行文件",
        prompt: "仅填写可执行文件，例如 npx；参数在下一步填写。",
        validateInput: (value) =>
          !value.trim() || /[\u0000-\u001f]/.test(value)
            ? "请输入有效的可执行文件名称或路径。"
            : undefined,
        ignoreFocusOut: true,
      });
      if (!command) return;
      const args = await vscode.window.showInputBox({
        title: "MCP 参数（JSON 数组）",
        value: "[]",
        placeHolder: '["-y", "@modelcontextprotocol/server-filesystem", "."]',
        validateInput: (value) => {
          try {
            const parsed: unknown = JSON.parse(value);
            return Array.isArray(parsed) &&
              parsed.every((item) => typeof item === "string")
              ? undefined
              : "请输入字符串数组。";
          } catch {
            return "JSON 格式无效。";
          }
        },
        ignoreFocusOut: true,
      });
      if (args === undefined) return;
      server.command = command.trim();
      server.args = JSON.parse(args) as string[];
    } else {
      const url = await vscode.window.showInputBox({
        title: "MCP HTTP 地址",
        placeHolder: "https://example.com/mcp",
        validateInput: (value) => {
          try {
            const parsed = new URL(value);
            return ["https:", "http:"].includes(parsed.protocol) &&
              !parsed.username &&
              !parsed.password
              ? undefined
              : "请输入不含账号密码的 HTTP(S) 地址。";
          } catch {
            return "地址无效。";
          }
        },
        ignoreFocusOut: true,
      });
      if (!url) return;
      server.url = url;
    }
    await this.save(config, ["mcpServers", name], server);
    this.snapshot!.notice =
      "MCP 已添加。环境变量、headers、OAuth 和超时等高级字段可通过“编辑配置”设置；认证由 PI 管理。";
  }
  private async createSkill(scope: ResourceScope) {
    const name = await vscode.window.showInputBox({
      title: `新建 Skill · ${scopeLabel(scope)}`,
      prompt: "小写字母、数字和单连字符，最长 64 字符",
      validateInput: (value) =>
        value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
          ? undefined
          : "名称格式无效。",
      ignoreFocusOut: true,
    });
    if (!name) return;
    const description = await vscode.window.showInputBox({
      title: "Skill 描述",
      prompt: "说明这个技能做什么、何时使用。",
      validateInput: (value) =>
        value.trim() && value.length <= 1024
          ? undefined
          : "请填写 1–1024 字符的描述。",
      ignoreFocusOut: true,
    });
    if (!description) return;
    this.assertActiveWorkspace();
    const directory = path.join(
      scope === "user" ? agentDirectory() : path.join(this.workspace!, ".pi"),
      "skills",
      name,
    );
    await mkdir(directory, { recursive: true });
    this.assertActiveWorkspace();
    const file = path.join(directory, "SKILL.md");
    await writeFile(
      file,
      `---\nname: ${name}\ndescription: ${JSON.stringify(description.trim())}\n---\n\n# ${name}\n\n在这里编写技能说明。\n`,
      { flag: "wx", mode: 0o600 },
    );
    this.markPending();
    await this.openSource(file);
    await this.refresh();
  }
  private async addPath(scope: ResourceScope, kind: "skills" | "extensions") {
    const choice = await vscode.window.showQuickPick(
      ["选择文件夹", "选择文件"],
      {
        title:
          kind === "skills" ? "添加本地 Skill 路径" : "添加本地 PI 扩展路径",
      },
    );
    if (!choice) return;
    const selected = await vscode.window.showOpenDialog({
      canSelectFolders: choice === "选择文件夹",
      canSelectFiles: choice === "选择文件",
      canSelectMany: false,
      title: "选择 PI 资源来源",
    });
    if (!selected?.[0] || selected[0].scheme !== "file") return;
    const config = await readResourceConfig(
      configPath(this.workspace!, agentDirectory(), scope),
    );
    const values = resourcePaths(config, kind);
    const file = selected[0].fsPath;
    if (!values.includes(file))
      await this.save(config, [kind], [...values, file]);
  }
  private async toggle(entry: Entry) {
    if (entry.view.kind === "mcp") {
      const servers = entry.config.value.mcpServers;
      if (!isRecord(servers) || !isRecord(servers[entry.target]))
        throw new Error("MCP 配置无效。");
      await this.save(
        entry.config,
        ["mcpServers", entry.target, "enabled"],
        entry.view.state === "配置已禁用",
      );
    } else if (
      entry.view.kind === "skills" ||
      entry.view.kind === "extensions"
    ) {
      await this.save(
        entry.config,
        [entry.view.kind],
        exactResourceRule(
          entry.config,
          entry.view.kind,
          entry.target,
          entry.view.state === "精确规则已禁用",
        ),
      );
    }
  }
  private async projectOverride(entry: Entry) {
    const config = await readResourceConfig(
      configPath(this.workspace!, agentDirectory(), "project", true),
    );
    if (
      config.value.mcpServers !== undefined &&
      !isRecord(config.value.mcpServers)
    )
      throw new Error("项目 mcpServers 配置无效，请先修复。");
    const choice = await vscode.window.showQuickPick(
      ["在本项目启用", "在本项目禁用"],
      { title: `${entry.target} · 项目启用设置` },
    );
    if (choice)
      await this.save(
        config,
        ["mcpServers", entry.target, "enabled"],
        choice === "在本项目启用",
      );
  }
  private async exposure(entry: Entry) {
    const choice = await vscode.window.showQuickPick(
      [
        { label: "codemode", description: "通过 codemode 脚本使用（默认）" },
        { label: "deferred", description: "通过 tool_search 搜索后使用" },
        { label: "direct", description: "直接向模型声明工具" },
        { label: "hidden", description: "工具不可调用" },
      ],
      { title: "MCP 工具暴露方式" },
    );
    if (choice)
      await this.save(
        entry.config,
        ["mcpServers", entry.target, "exposure"],
        choice.label,
      );
  }
  private async filters(entry: Entry) {
    const kind = await vscode.window.showQuickPick(
      ["extensions", "skills", "prompts", "themes"],
      { title: "选择包内资源类型" },
    );
    if (!kind) return;
    const choice = await vscode.window.showQuickPick(
      ["加载包允许的全部资源", "不加载此类资源", "在配置文件中编辑过滤规则"],
      { title: `${entry.source} · ${kind}` },
    );
    if (!choice) return;
    if (choice === "在配置文件中编辑过滤规则")
      return this.openConfig(entry.config.path);
    const packages = entry.config.value.packages;
    if (!Array.isArray(packages) || entry.index === undefined)
      throw new Error("包声明已失效。");
    const original = packages[entry.index];
    const pkg: Record<string, unknown> = isRecord(original)
      ? { ...original }
      : { source: original };
    if (choice === "不加载此类资源") pkg[kind] = [];
    else delete pkg[kind];
    await this.save(entry.config, ["packages", entry.index], pkg);
  }
  private async remove(entry: Entry) {
    const choice = await vscode.window.showWarningMessage(
      `移除 ${entry.view.name}？`,
      {
        modal: true,
        detail:
          entry.view.kind === "packages"
            ? "由 PI CLI 移除包及其声明；其他作用域可能仍在使用该包。"
            : "移除配置声明；不会删除本地 Skill 或扩展源文件。MCP OAuth 凭证由 PI 单独管理。",
      },
      "移除",
    );
    if (choice !== "移除") return;
    if (entry.view.kind === "packages" && entry.source) {
      const latest = await readResourceConfig(entry.config.path);
      if (latest.text !== entry.config.text)
        throw new Error("包配置已改变，请刷新后重试。");
      await this.cli("remove", [
        "remove",
        packageCliSource(entry.source, entry.config),
        ...(entry.view.scope === "project" ? ["--local"] : []),
      ]);
    } else if (entry.view.kind === "mcp")
      await this.save(entry.config, ["mcpServers", entry.target], undefined);
    else if (
      entry.index !== undefined &&
      ["skills", "extensions"].includes(entry.view.kind)
    )
      await this.save(entry.config, [entry.view.kind, entry.index], undefined);
  }
  private async cli(operation: string, args: string[]) {
    this.assertActiveWorkspace();
    if (this.tasks.size)
      throw new Error("已有 PI 资源管理命令在执行，请先在任务终端结束该命令。");
    if (operation === "update" || operation === "updateAll") {
      const choice = await vscode.window.showWarningMessage(
        "更新 PI 扩展包？",
        {
          modal: true,
          detail:
            operation === "updateAll"
              ? "执行 pi update --extensions，范围由 PI 决定，包含用户和项目包。不会执行 PI 自身更新。"
              : "PI 按来源更新匹配的用户和项目包；范围不受面板当前页签限制。不会执行 PI 自身更新。",
        },
        "更新扩展包",
      );
      if (!choice) return;
    }
    const config = vscode.workspace.getConfiguration("pi");
    if (
      ["install", "remove", "update", "updateAll", "configure"].includes(
        operation,
      )
    ) {
      const files = ["user", "project"].map((scope) =>
        configPath(this.workspace!, agentDirectory(), scope as ResourceScope),
      );
      if (
        vscode.workspace.textDocuments.some(
          (document) => files.includes(document.uri.fsPath) && document.isDirty,
        )
      )
        throw new Error(
          "PI settings.json 有未保存的编辑，请先保存或撤销，再执行包管理或终端配置。",
        );
    }
    this.assertActiveWorkspace();
    const discovery = new AbortController();
    this.launchAbort = discovery;
    let launch;
    try {
      launch = await resolvePiLaunch(
        {
          executablePath: config.get("executablePath"),
          nodePath: config.get("nodePath"),
        },
        { ...process.env },
        { cwd: this.workspace, signal: discovery.signal },
      );
    } finally {
      if (this.launchAbort === discovery) this.launchAbort = undefined;
    }
    if (this.disposed) return;
    this.assertActiveWorkspace();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(launch.env))
      if (value !== undefined) env[key] = value;
    const folder = vscode.workspace.workspaceFolders?.find(
      (folder) => folder.uri.fsPath === this.workspace,
    );
    if (!folder) throw new Error("工作区已改变，请重新打开资源管理。");
    const task = new vscode.Task(
      { type: "pi-resource", operation },
      folder,
      `PI 资源：${operation}`,
      "PI",
      new vscode.ProcessExecution(launch.command, [...launch.args, ...args], {
        cwd: this.workspace,
        env,
      }),
      [],
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      focus: true,
      clear: true,
      echo: false,
    };
    this.startingTask = true;
    try {
      const execution = await vscode.tasks.executeTask(task);
      if (this.disposed) {
        execution.terminate();
        return;
      }
      this.tasks.set(execution, operation);
      this.snapshot!.notice = `已在任务终端运行 PI CLI。${operation === "diagnose" ? "这是独立进程的 MCP 诊断，不能代表侧栏进程的实时状态。" : "完成后会刷新配置；需要时重新连接应用。"}`;
      if (this.earlyTaskEnds.has(execution))
        this.endTask(execution, this.earlyTaskEnds.get(execution));
    } finally {
      this.startingTask = false;
      this.earlyTaskEnds.clear();
    }
  }
}
