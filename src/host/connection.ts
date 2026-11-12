import * as vscode from "vscode";
import { assertWorkspace, PiNotFoundError } from "../pi/launcher";
import type { PiController } from "../pi/controller";
import type { SessionService } from "../features/sessions";
import type { ModelService } from "../features/models";
import type { CommandService } from "../features/commands";
import type { ContextService } from "../features/context";
import type { ExtensionUiManager } from "../features/extension-ui";

interface ConnectionServices {
  controller: PiController;
  sessions: SessionService;
  models: ModelService;
  commands: CommandService;
  usage: ContextService;
  ui: ExtensionUiManager;
  report: (error: unknown) => void;
}

export function createConnection({
  controller,
  sessions,
  models,
  commands,
  usage,
  ui,
  report,
}: ConnectionServices) {
  let initializing = false;
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
  return {
    connect,
    get initializing() {
      return initializing;
    },
  };
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
