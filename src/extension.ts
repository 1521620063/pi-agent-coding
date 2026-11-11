import * as vscode from 'vscode';
import { SessionStore } from './state/session-store';
import { createSidebarProvider } from './sidebar/provider';
import { PiController } from './pi/controller';
import { assertWorkspace } from './pi/launcher';
import { ExtensionUiManager } from './features/extension-ui';
import { AttachmentService } from './features/attachments';
import { ModelService } from './features/models';
import { CommandService } from './features/commands';
import { SessionService } from './features/sessions';
import { QueueService } from './features/queues';
import { ContextService, RetryService } from './features/context';
import { HistoryService } from './features/history';
import { ShellService } from './features/shell';
import { pathToFileURL } from 'node:url';
let activeController: PiController | undefined;
export function activate(context: vscode.ExtensionContext) {
  const store = new SessionStore();
  const output = vscode.window.createOutputChannel('PI');
  const config = vscode.workspace.getConfiguration('pi');
  const controller = new PiController(store, {executablePath:config.get('executablePath'),nodePath:config.get('nodePath'),requestTimeoutMs:config.get('requestTimeoutMs'),startupTimeoutMs:config.get('startupTimeoutMs'),shutdownTimeoutMs:config.get('shutdownTimeoutMs'),trusted:vscode.workspace.isTrusted,remote:!!vscode.env.remoteName}, text => output.append(text));
  activeController = controller;
  const attachments=new AttachmentService(store,async()=>{const files=await vscode.window.showOpenDialog({canSelectMany:true,canSelectFiles:true,canSelectFolders:false,title:'添加 UTF-8 文件或图片'});return files?.map(file=>file.fsPath);});
  const models=new ModelService(controller,store);const commands=new CommandService(controller,store);
  const sessions=new SessionService(controller,store,context.workspaceState,async()=>{const files=await vscode.window.showOpenDialog({canSelectMany:false,filters:{'PI session':['jsonl']},title:'打开已有 PI 会话'});return files?.[0]?.fsPath;});
  const queues=new QueueService(controller,store);const usage=new ContextService(controller,store);const retry=new RetryService(controller,store);const shell=new ShellService(controller,store);
  const history=new HistoryService(controller,store,async()=>{ui.dispose();await sessions.refresh();await Promise.all([models.refresh(),commands.refresh(),usage.refreshStats()]);},async()=>{const uri=await vscode.window.showSaveDialog({filters:{HTML:['html']},saveLabel:'导出 PI 对话'});return uri?.fsPath;});
  const attachSelection=async()=>{const editor=vscode.window.activeTextEditor;if(!editor)throw new Error('请先选择编辑器中的文本。');await attachments.fromSelection(editor);await vscode.commands.executeCommand('pi.sidebar.focus');};
  const ui = new ExtensionUiManager(store,response => controller.respond(response),async request => {
    if(request.method==='select'){const value=await vscode.window.showQuickPick((request.options??[]) as string[],{title:request.title});return value===undefined?{cancelled:true}:{value};}
    if(request.method==='confirm'){const value=await vscode.window.showWarningMessage(String(request.title),{modal:true,detail:request.message},'确认');return value===undefined?{cancelled:true}:{confirmed:true};}
    if(request.method==='editor'){const document=await vscode.workspace.openTextDocument({content:request.prefill??'',language:'plaintext'});await vscode.window.showTextDocument(document,{preview:false});const choice=await vscode.window.showInformationMessage(`${request.title??'PI 编辑器'}：编辑完成后提交当前文档内容。`,'提交内容','取消');return choice==='提交内容'?{value:document.getText()}:{cancelled:true};}
    const value=await vscode.window.showInputBox({title:request.title,value:request.prefill,placeHolder:request.placeholder,ignoreFocusOut:true});return value===undefined?{cancelled:true}:{value};
  },request=>{const fn=request.notifyType==='error'?vscode.window.showErrorMessage:request.notifyType==='warning'?vscode.window.showWarningMessage:vscode.window.showInformationMessage;void fn(String(request.message));});
  const report=(error:unknown)=>store.update({error:error instanceof Error?error.message:String(error)});
  const unsubscribe=controller.onRecord(record=>{
    if(record.type==='extension_ui_request')ui.handle(record as any);
    if(record.type==='session_info_changed')void sessions.remember().catch(report);
    if(record.type==='agent_settled'||record.type==='compaction_end')void usage.refreshStats().catch(report);
  });
  const connect = async () => {
    const folders = vscode.workspace.workspaceFolders;
    const folder = folders?.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({placeHolder:'选择 PI 工作目录'});
    if (!folder && folders?.length) return;
    assertWorkspace({trusted:vscode.workspace.isTrusted,remote:!!vscode.env.remoteName,uri:folder?.uri.toString()});
    const latest=vscode.workspace.getConfiguration('pi');controller.configure({executablePath:latest.get('executablePath'),nodePath:latest.get('nodePath'),requestTimeoutMs:latest.get('requestTimeoutMs'),startupTimeoutMs:latest.get('startupTimeoutMs'),shutdownTimeoutMs:latest.get('shutdownTimeoutMs'),trusted:vscode.workspace.isTrusted,remote:!!vscode.env.remoteName});ui.dispose();
    await controller.connect(folder!.uri.toString());
    await sessions.refresh();await Promise.all([models.refresh(),commands.refresh(),usage.refreshStats()]);
  };
  const provider = createSidebarProvider(store, async action => {
    store.update({error:undefined});
    if (action.type === 'connect') await connect();
    if (action.type === 'disconnect') {ui.dispose();await controller.disconnect();}
    if (action.type === 'settings') await vscode.commands.executeCommand('workbench.action.openSettings','@ext:pi-extension.pi-sidebar');
    if(action.type==='send'){const payload=await attachments.buildPayload(action.attachmentIds);await queues.submit([action.text,payload.text].filter(Boolean).join('\n\n'),payload.images,action.mode);for(const id of action.attachmentIds)attachments.remove(id);provider.post({type:'sent',attachmentIds:action.attachmentIds});}
    if(action.type==='attachSelection')await attachSelection();
    if(action.type==='attachFiles')await attachments.pickFiles();
    if(action.type==='removeAttachment')attachments.remove(action.id);
    if(action.type==='image'){if(!/^[A-Za-z0-9+/]*={0,2}$/.test(action.data))throw new Error('无效图片编码');await attachments.addImage({bytes:Buffer.from(action.data,'base64'),mimeType:action.mimeType,name:action.name});}
    if(action.type==='chooseModel'){await models.refresh();const pick=await vscode.window.showQuickPick(store.getSnapshot().models.map(model=>({label:model.name??model.id,description:model.provider,model})),{title:'PI 模型'});if(pick){await models.select(pick.model.provider,pick.model.id);await usage.refreshStats();}}
    if(action.type==='chooseThinking'){await models.refresh();const pick=await vscode.window.showQuickPick(store.getSnapshot().thinkingLevels.map(level=>({label:level,level})),{title:'PI 思考强度'});if(pick)await models.setThinking(pick.level);}
    if(action.type==='stop')await controller.stopAll();
    if(action.type==='openLink')await vscode.env.openExternal(vscode.Uri.parse(action.url));
    if(action.type==='newSession'||action.type==='openSession'){if(action.type==='newSession')await sessions.create();else await sessions.openFromPicker();await Promise.all([models.refresh(),commands.refresh(),usage.refreshStats()]);}
    if(action.type==='renameSession'){const name=await vscode.window.showInputBox({title:'PI 会话名称',value:store.getSnapshot().session?.name});if(name!==undefined)await sessions.rename(name);}
    if(action.type==='sessions'){
      const workspace=store.getSnapshot().workspace;if(!workspace)throw new Error('请先连接工作区。');
      const refs=await sessions.list(pathToFileURL(workspace).href);
      const pick=await vscode.window.showQuickPick([{label:'打开其他 PI 会话文件…',ref:undefined},...refs.map(ref=>({label:ref.name??ref.sessionId,description:ref.lastOpenedAt,ref}))],{title:'当前工作区通过插件打开的会话'});
      if(pick){try{if(pick.ref)await sessions.resume(pick.ref);else await sessions.openFromPicker();await Promise.all([models.refresh(),commands.refresh(),usage.refreshStats()]);}catch(error){if(pick.ref){const choice=await vscode.window.showWarningMessage(`恢复失败：${String(error)}`,'移除此索引');if(choice)await sessions.remove(pick.ref);}else throw error;}}
    }
    if(action.type==='clearQueue'){const cleared=await queues.clear();const text=[...cleared.steering,...cleared.followUp].join('\n\n');if(text)store.update({editorText:{text,append:true,revision:(store.getSnapshot().editorText?.revision??0)+1}});}
    if(action.type==='autoRetry')await retry.setEnabled(action.enabled);
    if(action.type==='cancelRetry')await retry.cancel();
    if(action.type==='autoCompaction')await usage.setAutoCompaction(action.enabled);
    if(action.type==='compact'){const instructions=await vscode.window.showInputBox({title:'压缩上下文',prompt:'可选：需要在摘要中保留什么？留空使用 PI 默认策略。'});if(instructions!==undefined)await usage.compact(instructions||undefined);}
    if(action.type==='fork'){const points=await history.listForkPoints();const pick=await vscode.window.showQuickPick(points.map(point=>({label:point.text.slice(0,120)||'(空消息)',point})),{title:'从用户消息分叉 · 不回滚文件'});if(pick)await history.fork(pick.point.entryId);}
    if(action.type==='clone')await history.clone();
    if(action.type==='export'){const path=await history.exportHtml();if(path)void vscode.window.showInformationMessage(`PI 对话已导出：${path}`);}
    if(action.type==='tree'){
      const result=await history.getTree();const items:vscode.QuickPickItem[]=[];
      const visit=(nodes:any[],depth=0)=>{for(const node of nodes??[]){if(items.length>=10000||depth>100)return;const entry=node.entry??{};const content=entry.message?.content;const text=typeof content==='string'?content:Array.isArray(content)?content.filter((block:any)=>block.type==='text').map((block:any)=>block.text).join(' '):'';items.push({label:`${'  '.repeat(depth)}${entry.id===result.leafId?'●':'·'} ${entry.type??'entry'} ${entry.message?.role??''}`,description:String(text||entry.name||entry.label||entry.id||'').slice(0,140)});visit(node.children,depth+1);}};
      visit(result.tree);await vscode.window.showQuickPick(items,{title:'PI 历史树 · 只读浏览',placeHolder:'搜索历史节点；选择节点不会改变对话或文件'});
    }
    if(action.type==='shell')await shell.execute(action.command,action.excludeFromContext);
    if(action.type==='cancelShell')await shell.cancel();
  }, context.extensionUri);
  context.subscriptions.push(output, provider, {dispose:() => {unsubscribe();ui.dispose();shell.dispose();void controller.disconnect();}}, vscode.window.registerWebviewViewProvider('pi.sidebar', provider), vscode.commands.registerCommand('pi.open', () => vscode.commands.executeCommand('pi.sidebar.focus')),vscode.commands.registerCommand('pi.reconnect',connect),vscode.commands.registerCommand('pi.attachSelection',attachSelection));
  return { store, controller, attachments };
}
export async function deactivate() { await activeController?.disconnect(); activeController = undefined; }
