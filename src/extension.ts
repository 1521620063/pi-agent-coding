import * as vscode from "vscode";
import * as path from "node:path";
import { SessionStore } from "./state/session-store";
import { createSidebarProvider } from "./sidebar/provider";
import { PiController } from "./pi/controller";
import { assertWorkspace, PiNotFoundError } from "./pi/launcher";
import { ExtensionUiManager } from "./features/extension-ui";
import { AttachmentService } from "./features/attachments";
import { ModelService } from "./features/models";
import { CommandService } from "./features/commands";
import { SessionService } from "./features/sessions";
import { QueueService } from "./features/queues";
import { ContextService, RetryService } from "./features/context";
import { HistoryService } from "./features/history";
import { ShellService } from "./features/shell";
import { ActionGate } from "./features/action-gate";
import { WorkspaceContextService } from "./features/workspace-context";
import { TaskNotifications } from "./features/notifications";
let activeController: PiController | undefined;
export function activate(context: vscode.ExtensionContext) {
  const store = new SessionStore();
  const output = vscode.window.createOutputChannel("PI");
  const config = vscode.workspace.getConfiguration("pi");
  const controller = new PiController(
    store,
    {
      executablePath: config.get("executablePath"),
      nodePath: config.get("nodePath"),
      requestTimeoutMs: config.get("requestTimeoutMs"),
      startupTimeoutMs: config.get("startupTimeoutMs"),
      shutdownTimeoutMs: config.get("shutdownTimeoutMs"),
      trusted: vscode.workspace.isTrusted,
      remote: !!vscode.env.remoteName,
    },
    (text) => output.append(text),
  );
  activeController = controller;
  const attachments = new AttachmentService(store, async () => {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
      title: "添加 UTF-8 文件或图片",
    });
    return files?.map((file) => file.fsPath);
  });
  const workspaceContext = new WorkspaceContextService(store, attachments);
  const models = new ModelService(controller, store);
  const commands = new CommandService(controller, store);
  const sessions = new SessionService(
    controller,
    store,
    context.workspaceState,
    async () => {
      const files = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { "PI session": ["jsonl"] },
        title: "打开已有 PI 会话",
      });
      return files?.[0]?.fsPath;
    },
  );
  const queues = new QueueService(controller, store);
  const usage = new ContextService(controller, store);
  const retry = new RetryService(controller, store);
  const shell = new ShellService(controller, store);
  const history = new HistoryService(
    controller,
    store,
    async () => {
      ui.dispose();
      await sessions.refresh();
      await Promise.all([
        models.refresh(),
        commands.refresh(),
        usage.refreshStats(),
      ]);
    },
    async () => {
      const uri = await vscode.window.showSaveDialog({
        filters: { HTML: ["html"] },
        saveLabel: "导出 PI 对话",
      });
      return uri?.fsPath;
    },
  );
  const attachSelection = async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) throw new Error("请先选择编辑器中的文本。");
    await attachments.fromSelection(editor);
    await vscode.commands.executeCommand("pi.sidebar.focus");
  };
  const ui = new ExtensionUiManager(
    store,
    (response) => controller.respond(response),
    async (request) => {
      if (request.method === "select") {
        const value = await vscode.window.showQuickPick(
          (request.options ?? []) as string[],
          { title: request.title },
        );
        return value === undefined ? { cancelled: true } : { value };
      }
      if (request.method === "confirm") {
        const value = await vscode.window.showWarningMessage(
          String(request.title),
          { modal: true, detail: request.message },
          "确认",
        );
        return value === undefined ? { cancelled: true } : { confirmed: true };
      }
      if (request.method === "editor") {
        const document = await vscode.workspace.openTextDocument({
          content: request.prefill ?? "",
          language: "plaintext",
        });
        await vscode.window.showTextDocument(document, { preview: false });
        const choice = await vscode.window.showInformationMessage(
          `${request.title ?? "PI 编辑器"}：编辑完成后提交当前文档内容。`,
          "提交内容",
          "取消",
        );
        return choice === "提交内容"
          ? { value: document.getText() }
          : { cancelled: true };
      }
      const value = await vscode.window.showInputBox({
        title: request.title,
        value: request.prefill,
        placeHolder: request.placeholder,
        ignoreFocusOut: true,
      });
      return value === undefined ? { cancelled: true } : { value };
    },
    (request) => {
      const fn =
        request.notifyType === "error"
          ? vscode.window.showErrorMessage
          : request.notifyType === "warning"
            ? vscode.window.showWarningMessage
            : vscode.window.showInformationMessage;
      void fn(String(request.message));
    },
  );
  const report = (error: unknown) =>
    store.update({
      error: error instanceof Error ? error.message : String(error),
    });
  let initializing = false;
  const unsubscribe = controller.onRecord((record) => {
    if (record.type === "extension_ui_request") ui.handle(record as any);
    if (record.type === "session_info_changed" && !initializing)
      void sessions.remember().catch(report);
    if (record.type === "agent_settled" || record.type === "compaction_end")
      void usage.refreshStats().catch(report);
  });
  const connect = async () => {
    const folders = vscode.workspace.workspaceFolders;
    const folder =
      folders?.length === 1
        ? folders[0]
        : await vscode.window.showWorkspaceFolderPick({
            placeHolder: "选择 PI 工作目录",
          });
    if (!folder && folders?.length) return;
    assertWorkspace({
      trusted: vscode.workspace.isTrusted,
      remote: !!vscode.env.remoteName,
      uri: folder?.uri.toString(),
    });
    const latest = vscode.workspace.getConfiguration("pi");
    controller.configure({
      executablePath: latest.get("executablePath"),
      nodePath: latest.get("nodePath"),
      requestTimeoutMs: latest.get("requestTimeoutMs"),
      startupTimeoutMs: latest.get("startupTimeoutMs"),
      shutdownTimeoutMs: latest.get("shutdownTimeoutMs"),
      trusted: vscode.workspace.isTrusted,
      remote: !!vscode.env.remoteName,
    });
    initializing = true;
    try {
      ui.dispose();
      try {
        await controller.connect(folder!.uri.toString());
      } catch (error) {
        if (error instanceof PiNotFoundError)
          void showPiInstallationGuide().catch(report);
        throw error;
      }
      try {
        if (!(await sessions.restoreLast())) await sessions.refresh();
      } catch (error) {
        report(
          new Error(
            `无法恢复上次会话：${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        await sessions.refresh();
      }
      await Promise.all([
        models.refresh(),
        commands.refresh(),
        usage.refreshStats(),
      ]);
    } finally {
      initializing = false;
    }
  };
  const gate = new ActionGate();
  const provider = createSidebarProvider(
    store,
    async (action) =>
      gate.run(action.type, async () => {
        if (action.type !== "searchFiles") store.update({ error: undefined });
        if (action.type === "searchFiles") {
          try {
            provider.post({
              type: "fileCandidates",
              requestId: action.requestId,
              ...(await workspaceContext.search(action.query)),
            });
          } catch (error) {
            provider.post({
              type: "fileCandidates",
              requestId: action.requestId,
              items: [],
              truncated: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (action.type === "attachContext") {
          try {
            await workspaceContext.attach(action.id);
            provider.post({
              type: "contextAttached",
              id: action.id,
              success: true,
            });
          } catch (error) {
            provider.post({
              type: "contextAttached",
              id: action.id,
              success: false,
            });
            throw error;
          }
        }
        if (action.type === "openFile")
          await workspaceContext.openReference(action.reference);
        if (action.type === "connect") await connect();
        if (action.type === "disconnect") {
          ui.dispose();
          await queues.cancelPromotion();
          await controller.disconnect();
        }
        if (action.type === "settings")
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "@ext:pi-extension.pi-sidebar",
          );
        if (action.type === "send") {
          if (action.text.startsWith("!")) {
            if (action.attachmentIds.length)
              throw new Error(
                "独立命令不接收附件，请先移除附件或发送普通消息。",
              );
            const command = action.text.slice(1).trim();
            if (!command) throw new Error("请在 ! 后输入命令。");
            if (command.length > 100000)
              throw new Error("插件命令限制：最多 100,000 字符。");
            await shell.execute(command, false);
            provider.post({ type: "sent", attachmentIds: [] });
            return;
          }
          const payload = await attachments.buildPayload(action.attachmentIds);
          await queues.submit(
            [action.text, payload.text].filter(Boolean).join("\n\n"),
            payload.images,
            action.mode,
          );
          for (const id of action.attachmentIds) attachments.remove(id);
          provider.post({ type: "sent", attachmentIds: action.attachmentIds });
        }
        if (action.type === "attachSelection") await attachSelection();
        if (action.type === "attachFiles") {
          const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            canSelectFiles: true,
            canSelectFolders: false,
            title: "添加 UTF-8 文件或图片",
          });
          if (uris) await workspaceContext.attachUris(uris);
        }
        if (action.type === "attachDiagnostics")
          await workspaceContext.attachDiagnostics();
        if (action.type === "copyText")
          await vscode.env.clipboard.writeText(action.text);
        if (action.type === "openCode") {
          const languages = await vscode.languages.getLanguages();
          const aliases: Record<string, string> = {
            js: "javascript",
            ts: "typescript",
            py: "python",
            sh: "shellscript",
            bash: "shellscript",
            md: "markdown",
            csharp: "csharp",
          };
          const language = aliases[action.language] ?? action.language;
          const document = await vscode.workspace.openTextDocument({
            content: action.text,
            language: languages.includes(language) ? language : "plaintext",
          });
          await vscode.window.showTextDocument(document, { preview: false });
        }
        if (action.type === "forkMessage")
          await history.forkMessage(action.index);
        if (action.type === "queueMode")
          await queues.setMode(action.channel, action.mode);
        if (action.type === "promoteQueued")
          await queues.promote(action.index, action.revision);
        if (action.type === "cycleModel") await models.cycleModel();
        if (action.type === "cycleThinking") await models.cycleThinking();
        if (action.type === "openScm")
          await vscode.commands.executeCommand("workbench.view.scm");
        if (action.type === "touchedFiles") {
          const files = [
            ...new Set(
              store
                .getSnapshot()
                .tools.filter(
                  (tool) =>
                    ["write", "edit"].includes(tool.name) &&
                    tool.status === "success",
                )
                .map((tool) => tool.args.path)
                .filter((value): value is string => typeof value === "string"),
            ),
          ];
          const selected = await vscode.window.showQuickPick(files, {
            title: "本次对话已观察到的修改文件",
            placeHolder: files.length
              ? "选择文件跳转；差异请在源代码管理中查看"
              : "尚未观察到 write / edit 成功结果",
          });
          if (selected) await workspaceContext.openReference(selected);
        }
        if (action.type === "showCommands") {
          const selected = await vscode.window.showQuickPick(
            store.getSnapshot().commands.map((command) => ({
              label: `/${command.name}`,
              description: [
                command.source,
                command.sourceInfo?.scope,
                command.sourceInfo?.origin,
              ]
                .filter(Boolean)
                .join(" · "),
              detail: command.sourceInfo?.path ?? "PI 未提供可查看的来源路径",
              command,
            })),
            {
              title: "PI 技能与模板来源",
              matchOnDescription: true,
              matchOnDetail: true,
            },
          );
          const source = selected?.command.sourceInfo?.path;
          if (
            source &&
            vscode.workspace.isTrusted &&
            !vscode.env.remoteName &&
            path.isAbsolute(source) &&
            !/[\u0000-\u001f]/.test(source)
          ) {
            const document = await vscode.workspace.openTextDocument(
              vscode.Uri.file(source),
            );
            await vscode.window.showTextDocument(document, { preview: true });
          }
        }
        if (action.type === "searchConversation") {
          const sessionId = store.getSnapshot().session?.id;
          const query = await vscode.window.showInputBox({
            title: "搜索 PI 完整历史",
            prompt: "包含压缩前及其他分支；最多显示 100 条，每条预览 4000 字符",
          });
          if (query && store.getSnapshot().session?.id === sessionId) {
            const matches = await history.search(query);
            const selected = await vscode.window.showQuickPick(
              matches.map((match) => ({
                label: match.text.slice(0, 120),
                description: match.entryId,
                match,
              })),
              {
                title: `完整历史：${matches.length}${matches.length === 100 ? "+" : ""} 条匹配`,
                matchOnDescription: true,
              },
            );
            if (selected && store.getSnapshot().session?.id === sessionId) {
              const document = await vscode.workspace.openTextDocument({
                content: selected.match.text,
                language: "plaintext",
              });
              await vscode.window.showTextDocument(document, { preview: true });
            }
          }
        }
        if (action.type === "removeAttachment") attachments.remove(action.id);
        if (action.type === "image") {
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(action.data))
            throw new Error("无效图片编码");
          await attachments.addImage({
            bytes: Buffer.from(action.data, "base64"),
            mimeType: action.mimeType,
            name: action.name,
          });
        }
        if (action.type === "refreshModels") await models.refresh();
        if (action.type === "chooseModel") {
          if (
            !store
              .getSnapshot()
              .models.some(
                (model) =>
                  model.provider === action.provider &&
                  model.id === action.modelId,
              )
          )
            throw new Error("此模型已不可用，请刷新后重试。");
          await models.select(action.provider, action.modelId);
          await usage.refreshStats();
        }
        if (action.type === "chooseThinking")
          await models.setThinking(action.level);
        if (action.type === "stop") {
          const uncertain = await queues.cancelPromotion();
          try {
            await controller.stopAll();
          } finally {
            if (uncertain) {
              // Aborting a local request does not cancel PI's input preflight.
              // Close our process so it cannot enqueue a late replay after abort.
              await controller.disconnect();
              store.update({
                error:
                  "引导提交尚未确认，已断开 PI 以阻止延迟执行。请检查对话后重新连接；未提交的文本已恢复到输入框。",
              });
            }
          }
        }
        if (action.type === "openLink")
          await vscode.env.openExternal(vscode.Uri.parse(action.url));
        if (action.type === "newSession" || action.type === "openSession") {
          if (action.type === "newSession") await sessions.create();
          else await sessions.openFromPicker();
          await Promise.all([
            models.refresh(),
            commands.refresh(),
            usage.refreshStats(),
          ]);
        }
        if (action.type === "renameSession") {
          const name = await vscode.window.showInputBox({
            title: "PI 会话名称",
            value: store.getSnapshot().session?.name,
          });
          if (name !== undefined) await sessions.rename(name);
        }
        if (action.type === "sessions") await sessions.refreshList();
        if (action.type === "removeSession")
          await sessions.removeFromHistory(action.sessionPath);
        if (action.type === "selectSession") {
          await sessions.selectFromHistory(action.sessionPath);
          await Promise.all([
            models.refresh(),
            commands.refresh(),
            usage.refreshStats(),
          ]);
        }
        if (action.type === "clearQueue") {
          const cleared = await queues.clear();
          const text = [...cleared.steering, ...cleared.followUp].join("\n\n");
          if (text)
            store.update({
              editorText: {
                text,
                append: true,
                revision: (store.getSnapshot().editorText?.revision ?? 0) + 1,
              },
            });
        }
        if (action.type === "autoRetry") await retry.setEnabled(action.enabled);
        if (action.type === "cancelRetry") await retry.cancel();
        if (action.type === "autoCompaction")
          await usage.setAutoCompaction(action.enabled);
        if (action.type === "compact") {
          const instructions = await vscode.window.showInputBox({
            title: "压缩上下文",
            prompt: "可选：需要在摘要中保留什么？留空使用 PI 默认策略。",
          });
          if (instructions !== undefined)
            await usage.compact(instructions || undefined);
        }
        if (action.type === "fork") {
          const points = await history.listForkPoints();
          const pick = await vscode.window.showQuickPick(
            points.map((point) => ({
              label: point.text.slice(0, 120) || "(空消息)",
              point,
            })),
            { title: "从用户消息分叉 · 不回滚文件" },
          );
          if (pick) await history.fork(pick.point.entryId);
        }
        if (action.type === "clone") await history.clone();
        if (action.type === "export") {
          const path = await history.exportHtml();
          if (path)
            void vscode.window.showInformationMessage(`PI 对话已导出：${path}`);
        }
        if (action.type === "tree") {
          const result = await history.getTree();
          const items: vscode.QuickPickItem[] = [];
          const visit = (nodes: any[], depth = 0) => {
            for (const node of nodes ?? []) {
              if (items.length >= 10000 || depth > 100) return;
              const entry = node.entry ?? {};
              const content = entry.message?.content;
              const text =
                typeof content === "string"
                  ? content
                  : Array.isArray(content)
                    ? content
                        .filter((block: any) => block.type === "text")
                        .map((block: any) => block.text)
                        .join(" ")
                    : "";
              items.push({
                label: `${"  ".repeat(depth)}${entry.id === result.leafId ? "●" : "·"} ${entry.type ?? "entry"} ${entry.message?.role ?? ""}`,
                description: String(
                  text || entry.name || entry.label || entry.id || "",
                ).slice(0, 140),
              });
              visit(node.children, depth + 1);
            }
          };
          visit(result.tree);
          await vscode.window.showQuickPick(items, {
            title: "PI 历史树 · 只读浏览",
            placeHolder: "搜索历史节点；选择节点不会改变对话或文件",
          });
        }
        if (action.type === "shell")
          await shell.execute(action.command, action.excludeFromContext);
        if (action.type === "cancelShell") await shell.cancel();
      }),
    context.extensionUri,
  );
  const notifications = new TaskNotifications();
  const stopNotifications = store.subscribe((state) => {
    const message = notifications.observe(
      state,
      provider.isVisible && vscode.window.state.focused,
    );
    if (message)
      void vscode.window
        .showInformationMessage(message, "打开 PI")
        .then((choice) => {
          if (choice === "打开 PI")
            void vscode.commands.executeCommand("pi.sidebar.focus");
        });
  });
  context.subscriptions.push(
    output,
    provider,
    {
      dispose: () => {
        unsubscribe();
        stopNotifications();
        ui.dispose();
        shell.dispose();
        queues.dispose();
        void controller.disconnect();
      },
    },
    vscode.window.registerWebviewViewProvider("pi.sidebar", provider),
    vscode.commands.registerCommand("pi.open", () =>
      vscode.commands.executeCommand("pi.sidebar.focus"),
    ),
    vscode.commands.registerCommand("pi.reconnect", () =>
      gate.run("connect", connect),
    ),
    vscode.commands.registerCommand("pi.attachSelection", attachSelection),
    vscode.commands.registerCommand(
      "pi.attachFiles",
      async (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
        const uris = selected?.length ? selected : uri ? [uri] : [];
        if (uris.length) await workspaceContext.attachUris(uris);
        await vscode.commands.executeCommand("pi.sidebar.focus");
      },
    ),
    vscode.commands.registerCommand("pi.cycleModel", () =>
      gate.run("cycleModel", () => models.cycleModel()),
    ),
    vscode.commands.registerCommand("pi.cycleThinking", () =>
      gate.run("cycleThinking", () => models.cycleThinking()),
    ),
  );
  if (
    vscode.workspace.isTrusted &&
    !vscode.env.remoteName &&
    vscode.workspace.workspaceFolders?.length &&
    vscode.workspace.workspaceFolders.every(
      (folder) => new URL(folder.uri.toString()).protocol === "file:",
    )
  )
    void gate.run("connect", connect).catch(report);
  return { store, controller, attachments };
}
async function showPiInstallationGuide() {
  const choice = await vscode.window.showInformationMessage(
    "未找到本机 PI。若尚未安装，请打开官方安装说明；安装后重启 VS Code，并在 PI 中完成登录或模型配置。若已安装，可配置 PI 路径后重新连接。",
    "打开安装说明",
    "配置 PI 路径",
  );
  if (choice === "打开安装说明")
    await vscode.env.openExternal(vscode.Uri.parse("https://pi.dev/"));
  if (choice === "配置 PI 路径")
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "pi.executablePath",
    );
}
export async function deactivate() {
  await activeController?.disconnect();
  activeController = undefined;
}
