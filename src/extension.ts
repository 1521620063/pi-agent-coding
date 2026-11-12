import * as vscode from "vscode";
import { SessionStore } from "./state/session-store";
import { createSidebarProvider } from "./sidebar/provider";
import { PiController } from "./pi/controller";
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
import { createActionHandler } from "./host/actions";
import { createConnection } from "./host/connection";
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
  const connection = createConnection({
    controller,
    sessions,
    models,
    commands,
    usage,
    ui,
    report,
  });
  const connect = connection.connect;
  const unsubscribe = controller.onRecord((record) => {
    if (record.type === "extension_ui_request") ui.handle(record as any);
    if (record.type === "session_info_changed" && !connection.initializing)
      void sessions.remember().catch(report);
    if (record.type === "agent_settled" || record.type === "compaction_end")
      void usage.refreshStats().catch(report);
  });
  const gate = new ActionGate();
  const provider = createSidebarProvider(
    store,
    createActionHandler({
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
      extensionId: context.extension.id,
      post: (message) => provider.post(message),
    }),
    context.extensionUri,
  );
  const notifications = new TaskNotifications();
  const stopNotifications = store.subscribe(
    (state) => {
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
    },
    [
      "session",
      "run",
      "pendingUi",
      "connection",
      "error",
      "compaction",
      "retry",
    ],
  );
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
export async function deactivate() {
  await activeController?.disconnect();
  activeController = undefined;
}
