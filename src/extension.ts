import * as vscode from 'vscode';
import { SessionStore } from './state/session-store';
import { createSidebarProvider } from './sidebar/provider';
import { PiController } from './pi/controller';
import { assertWorkspace } from './pi/launcher';
let activeController: PiController | undefined;
export function activate(context: vscode.ExtensionContext) {
  const store = new SessionStore();
  const output = vscode.window.createOutputChannel('PI');
  const config = vscode.workspace.getConfiguration('pi');
  const controller = new PiController(store, {executablePath:config.get('executablePath'),nodePath:config.get('nodePath'),requestTimeoutMs:config.get('requestTimeoutMs'),startupTimeoutMs:config.get('startupTimeoutMs'),shutdownTimeoutMs:config.get('shutdownTimeoutMs'),trusted:vscode.workspace.isTrusted,remote:!!vscode.env.remoteName}, text => output.append(text));
  activeController = controller;
  const connect = async () => {
    const folders = vscode.workspace.workspaceFolders;
    const folder = folders?.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({placeHolder:'选择 PI 工作目录'});
    if (!folder && folders?.length) return;
    assertWorkspace({trusted:vscode.workspace.isTrusted,remote:!!vscode.env.remoteName,uri:folder?.uri.toString()});
    await controller.connect(folder!.uri.toString());
  };
  const provider = createSidebarProvider(store, async action => {
    if (action.type === 'connect') await connect();
    if (action.type === 'disconnect') await controller.disconnect();
    if (action.type === 'settings') await vscode.commands.executeCommand('workbench.action.openSettings','@ext:pi-extension.pi-sidebar');
  }, context.extensionUri);
  context.subscriptions.push(output, provider, {dispose:() => {void controller.disconnect();}}, vscode.window.registerWebviewViewProvider('pi.sidebar', provider), vscode.commands.registerCommand('pi.open', () => vscode.commands.executeCommand('pi.sidebar.focus')),vscode.commands.registerCommand('pi.reconnect',connect));
  return { store, controller };
}
export async function deactivate() { await activeController?.disconnect(); activeController = undefined; }
