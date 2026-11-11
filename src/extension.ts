import * as vscode from 'vscode';
import { SessionStore } from './state/session-store';
import { createSidebarProvider } from './sidebar/provider';
import { PiController } from './pi/controller';
import { assertWorkspace } from './pi/launcher';
import { ExtensionUiManager } from './features/extension-ui';
let activeController: PiController | undefined;
export function activate(context: vscode.ExtensionContext) {
  const store = new SessionStore();
  const output = vscode.window.createOutputChannel('PI');
  const config = vscode.workspace.getConfiguration('pi');
  const controller = new PiController(store, {executablePath:config.get('executablePath'),nodePath:config.get('nodePath'),requestTimeoutMs:config.get('requestTimeoutMs'),startupTimeoutMs:config.get('startupTimeoutMs'),shutdownTimeoutMs:config.get('shutdownTimeoutMs'),trusted:vscode.workspace.isTrusted,remote:!!vscode.env.remoteName}, text => output.append(text));
  activeController = controller;
  const ui = new ExtensionUiManager(store,response => controller.respond(response),async request => {
    if(request.method==='select'){const value=await vscode.window.showQuickPick((request.options??[]) as string[],{title:request.title});return value===undefined?{cancelled:true}:{value};}
    if(request.method==='confirm'){const value=await vscode.window.showWarningMessage(String(request.title),{modal:true,detail:request.message},'确认');return value===undefined?{cancelled:true}:{confirmed:true};}
    const value=await vscode.window.showInputBox({title:request.title,value:request.prefill,placeHolder:request.placeholder,ignoreFocusOut:true});return value===undefined?{cancelled:true}:{value};
  },request=>{const fn=request.notifyType==='error'?vscode.window.showErrorMessage:request.notifyType==='warning'?vscode.window.showWarningMessage:vscode.window.showInformationMessage;void fn(String(request.message));});
  const unsubscribe=controller.onRecord(record=>{if(record.type==='extension_ui_request')ui.handle(record as any);});
  const connect = async () => {
    const folders = vscode.workspace.workspaceFolders;
    const folder = folders?.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({placeHolder:'选择 PI 工作目录'});
    if (!folder && folders?.length) return;
    assertWorkspace({trusted:vscode.workspace.isTrusted,remote:!!vscode.env.remoteName,uri:folder?.uri.toString()});
    await controller.connect(folder!.uri.toString());
    const result=await controller.request({type:'get_messages'});store.replaceMessages(result.messages);
  };
  const provider = createSidebarProvider(store, async action => {
    store.update({error:undefined});
    if (action.type === 'connect') await connect();
    if (action.type === 'disconnect') await controller.disconnect();
    if (action.type === 'settings') await vscode.commands.executeCommand('workbench.action.openSettings','@ext:pi-extension.pi-sidebar');
    if(action.type==='send'){if(action.attachmentIds.length)throw new Error('附件服务尚未连接');await controller.request({type:'prompt',message:action.text,streamingBehavior:action.mode},{timeoutMs:0});provider.post({type:'sent',attachmentIds:[]});}
    if(action.type==='stop')await controller.stopAll();
    if(action.type==='openLink')await vscode.env.openExternal(vscode.Uri.parse(action.url));
  }, context.extensionUri);
  context.subscriptions.push(output, provider, {dispose:() => {unsubscribe();ui.dispose();void controller.disconnect();}}, vscode.window.registerWebviewViewProvider('pi.sidebar', provider), vscode.commands.registerCommand('pi.open', () => vscode.commands.executeCommand('pi.sidebar.focus')),vscode.commands.registerCommand('pi.reconnect',connect));
  return { store, controller };
}
export async function deactivate() { await activeController?.disconnect(); activeController = undefined; }
