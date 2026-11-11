import * as vscode from 'vscode';
import { SessionStore } from './state/session-store';
import { createSidebarProvider } from './sidebar/provider';
import { PiController } from './pi/controller';
import { assertWorkspace } from './pi/launcher';
import { ExtensionUiManager } from './features/extension-ui';
import { AttachmentService } from './features/attachments';
import { ModelService } from './features/models';
import { CommandService } from './features/commands';
let activeController: PiController | undefined;
export function activate(context: vscode.ExtensionContext) {
  const store = new SessionStore();
  const output = vscode.window.createOutputChannel('PI');
  const config = vscode.workspace.getConfiguration('pi');
  const controller = new PiController(store, {executablePath:config.get('executablePath'),nodePath:config.get('nodePath'),requestTimeoutMs:config.get('requestTimeoutMs'),startupTimeoutMs:config.get('startupTimeoutMs'),shutdownTimeoutMs:config.get('shutdownTimeoutMs'),trusted:vscode.workspace.isTrusted,remote:!!vscode.env.remoteName}, text => output.append(text));
  activeController = controller;
  const attachments=new AttachmentService(store,async()=>{const files=await vscode.window.showOpenDialog({canSelectMany:true,canSelectFiles:true,canSelectFolders:false,title:'添加 UTF-8 文件或图片'});return files?.map(file=>file.fsPath);});
  const models=new ModelService(controller,store);const commands=new CommandService(controller,store);
  const attachSelection=async()=>{const editor=vscode.window.activeTextEditor;if(!editor)throw new Error('请先选择编辑器中的文本。');await attachments.fromSelection(editor);await vscode.commands.executeCommand('pi.sidebar.focus');};
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
    await Promise.all([models.refresh(),commands.refresh()]);
  };
  const provider = createSidebarProvider(store, async action => {
    store.update({error:undefined});
    if (action.type === 'connect') await connect();
    if (action.type === 'disconnect') await controller.disconnect();
    if (action.type === 'settings') await vscode.commands.executeCommand('workbench.action.openSettings','@ext:pi-extension.pi-sidebar');
    if(action.type==='send'){const payload=await attachments.buildPayload(action.attachmentIds);await controller.request({type:'prompt',message:[action.text,payload.text].filter(Boolean).join('\n\n'),images:payload.images,streamingBehavior:action.mode},{timeoutMs:0});for(const id of action.attachmentIds)attachments.remove(id);provider.post({type:'sent',attachmentIds:action.attachmentIds});}
    if(action.type==='attachSelection')await attachSelection();
    if(action.type==='attachFiles')await attachments.pickFiles();
    if(action.type==='removeAttachment')attachments.remove(action.id);
    if(action.type==='image'){if(!/^[A-Za-z0-9+/]*={0,2}$/.test(action.data))throw new Error('无效图片编码');await attachments.addImage({bytes:Buffer.from(action.data,'base64'),mimeType:action.mimeType,name:action.name});}
    if(action.type==='chooseModel'){await models.refresh();const pick=await vscode.window.showQuickPick(store.getSnapshot().models.map(model=>({label:model.name??model.id,description:model.provider,model})),{title:'PI 模型'});if(pick)await models.select(pick.model.provider,pick.model.id);}
    if(action.type==='chooseThinking'){await models.refresh();const level=await vscode.window.showQuickPick(store.getSnapshot().thinkingLevels,{title:'PI 思考强度'});if(level)await models.setThinking(level);}
    if(action.type==='stop')await controller.stopAll();
    if(action.type==='openLink')await vscode.env.openExternal(vscode.Uri.parse(action.url));
  }, context.extensionUri);
  context.subscriptions.push(output, provider, {dispose:() => {unsubscribe();ui.dispose();void controller.disconnect();}}, vscode.window.registerWebviewViewProvider('pi.sidebar', provider), vscode.commands.registerCommand('pi.open', () => vscode.commands.executeCommand('pi.sidebar.focus')),vscode.commands.registerCommand('pi.reconnect',connect),vscode.commands.registerCommand('pi.attachSelection',attachSelection));
  return { store, controller };
}
export async function deactivate() { await activeController?.disconnect(); activeController = undefined; }
