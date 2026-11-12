import * as vscode from "vscode";
import * as path from "node:path";
import type { SessionStore } from "../state/session-store";
import type { PiController } from "../pi/controller";
import type { ClientAction, HostMessage } from "../shared/bridge";
import type { ExtensionUiManager } from "../features/extension-ui";
import type { AttachmentService } from "../features/attachments";
import type { WorkspaceContextService } from "../features/workspace-context";
import type { ModelService } from "../features/models";
import type { CommandService } from "../features/commands";
import type { SessionService } from "../features/sessions";
import type { QueueService } from "../features/queues";
import type { ContextService, RetryService } from "../features/context";
import type { HistoryService } from "../features/history";
import type { ShellService } from "../features/shell";
import type { ActionGate } from "../features/action-gate";
import { parseBuiltinCommand } from "../shared/commands";

interface ActionServices {
  store: SessionStore;
  controller: PiController;
  attachments: AttachmentService;
  workspaceContext: WorkspaceContextService;
  models: ModelService;
  commands: CommandService;
  sessions: SessionService;
  queues: QueueService;
  usage: ContextService;
  retry: RetryService;
  history: HistoryService;
  shell: ShellService;
  ui: ExtensionUiManager;
  gate: ActionGate;
  connect: () => Promise<void>;
  attachSelection: () => Promise<void>;
  extensionId: string;
  post: (message: HostMessage) => void;
}

// Actions enter through ActionGate after the sidebar boundary validates them.
export function createActionHandler({
  store,
  controller,
  attachments,
  workspaceContext,
  models,
  commands,
  sessions,
  queues,
  usage,
  retry,
  history,
  shell,
  ui,
  gate,
  connect,
  attachSelection,
  extensionId,
  post,
}: ActionServices) {
  return async (action: ClientAction): Promise<void> => {
    const commandText = action.type === "send" ? action.text : "";
    const builtin =
      action.type === "send"
        ? parseBuiltinCommand(action.text, store.getSnapshot().commands)
        : undefined;
    return gate.run(builtin?.action ?? action.type, async () => {
      let cancelled = false;
      if (action.type !== "searchFiles") store.update({ error: undefined });
      if (builtin && action.type === "send") {
        if (action.attachmentIds.length && builtin.name !== "stop")
          throw new Error("会话命令不接收附件，请先移除附件。");
        const state = store.getSnapshot();
        if (state.connection !== "connected")
          throw new Error("请先连接 PI 再执行会话命令。");
        if (
          builtin.args &&
          builtin.name !== "compact" &&
          builtin.name !== "name"
        )
          throw new Error(
            `/${builtin.name} 不接收参数，请直接发送 /${builtin.name}。`,
          );
        if ("control" in builtin) {
          post({ type: "sent", attachmentIds: [] });
          post({ type: "showControl", control: builtin.control });
          return;
        }
        if (
          builtin.action === "compact" &&
          (state.run !== "idle" ||
            state.compaction.active ||
            state.queueControl?.busy)
        )
          throw new Error("请等待当前任务或压缩完成后再压缩上下文。");
        // Reuse the same handlers and transition gates as toolbar/menu actions.
        action = { type: builtin.action };
      }
      if (action.type === "searchFiles") {
        try {
          post({
            type: "fileCandidates",
            requestId: action.requestId,
            ...(await workspaceContext.search(action.query)),
          });
        } catch (error) {
          post({
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
          post({
            type: "contextAttached",
            id: action.id,
            success: true,
          });
        } catch (error) {
          post({
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
          `@ext:${extensionId}`,
        );
      if (action.type === "send") {
        if (action.text.startsWith("!")) {
          if (action.attachmentIds.length)
            throw new Error("独立命令不接收附件，请先移除附件或发送普通消息。");
          const command = action.text.slice(1).trim();
          if (!command) throw new Error("请在 ! 后输入命令。");
          if (command.length > 100000)
            throw new Error("插件命令限制：最多 100,000 字符。");
          await shell.execute(command, false);
          post({ type: "sent", attachmentIds: [] });
          return;
        }
        const payload = await attachments.buildPayload(action.attachmentIds);
        await queues.submit(
          [action.text, payload.text].filter(Boolean).join("\n\n"),
          payload.images,
          action.mode,
        );
        for (const id of action.attachmentIds) attachments.remove(id);
        post({ type: "sent", attachmentIds: action.attachmentIds });
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
        const { provider, modelId } = action;
        if (
          !store
            .getSnapshot()
            .models.some(
              (model) => model.provider === provider && model.id === modelId,
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
        const name =
          builtin?.args ||
          (await vscode.window.showInputBox({
            title: "PI 会话名称",
            value: store.getSnapshot().session?.name,
          }));
        if (name !== undefined) await sessions.rename(name);
        else cancelled = true;
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
        const instructions = builtin
          ? builtin.args
          : await vscode.window.showInputBox({
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
        else cancelled = true;
      }
      if (action.type === "clone") await history.clone();
      if (action.type === "export") {
        const path = await history.exportHtml();
        if (path)
          void vscode.window.showInformationMessage(`PI 对话已导出：${path}`);
        else cancelled = true;
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
      if (builtin?.name === "stop")
        post({ type: "commandCompleted", text: commandText });
      else if (builtin)
        post({
          type: "sent",
          attachmentIds: [],
          ...(cancelled ? { preserveDraft: true } : {}),
        });
    });
  };
}
