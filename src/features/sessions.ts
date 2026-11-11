import { pathToFileURL } from 'node:url';
import type { PiController } from '../pi/controller';
import type { SessionStore } from '../state/session-store';
export interface SessionRef {workspaceUri:string;sessionPath:string;sessionId:string;name?:string;lastOpenedAt:string}
interface Memory {get(key:string,defaultValue?:any):any;update(key:string,value:any):PromiseLike<void>}
export class SessionService {
 private switching=false;
 constructor(private pi:Pick<PiController,'request'|'stopAll'>,private store:SessionStore,private memory:Memory,private picker?:()=>Promise<string|undefined>){}
 async list(workspaceUri:string):Promise<SessionRef[]>{return this.refs().filter(ref=>ref.workspaceUri===workspaceUri).sort((a,b)=>b.lastOpenedAt.localeCompare(a.lastOpenedAt));}
 private refs():SessionRef[]{const refs=this.memory.get('pi.sessions.v1',[]);return Array.isArray(refs)?refs.filter(ref=>typeof ref?.workspaceUri==='string'&&typeof ref.sessionPath==='string'&&typeof ref.sessionId==='string'&&typeof ref.lastOpenedAt==='string'):[];}
 async remember():Promise<void>{const state=this.store.getSnapshot();if(!state.workspace||!state.session?.path)return;const ref:SessionRef={workspaceUri:pathToFileURL(state.workspace).href,sessionPath:state.session.path,sessionId:state.session.id,name:state.session.name,lastOpenedAt:new Date().toISOString()};await this.memory.update('pi.sessions.v1',[ref,...this.refs().filter(item=>item.sessionPath!==ref.sessionPath||item.workspaceUri!==ref.workspaceUri)].slice(0,100));}
 async remove(ref:SessionRef):Promise<void>{await this.memory.update('pi.sessions.v1',this.refs().filter(item=>item.sessionPath!==ref.sessionPath||item.workspaceUri!==ref.workspaceUri));}
 async refresh():Promise<void>{const state=await this.pi.request({type:'get_state'});const result=await this.pi.request({type:'get_messages'});if(typeof state.sessionId!=='string'||!Array.isArray(result.messages))throw new Error('Incompatible PI session response');this.store.replaceMessages(result.messages);this.store.update({session:{id:state.sessionId,path:state.sessionFile,name:state.sessionName},model:state.model,thinkingLevel:state.thinkingLevel,run:state.isStreaming?'running':'idle',stats:undefined,queues:{steering:[],followUp:[]},compaction:{enabled:state.autoCompactionEnabled,active:!!state.isCompacting},statuses:{},widgets:{},pendingUi:[]});await this.remember();}
 async create():Promise<void>{await this.change({type:'new_session'});}
 async openFromPicker():Promise<void>{const path=await this.picker?.();if(path)await this.change({type:'switch_session',sessionPath:path});}
 async resume(ref:SessionRef):Promise<void>{const current=this.store.getSnapshot().workspace;if(!current||pathToFileURL(current).href!==ref.workspaceUri)throw new Error('Session belongs to another workspace. Connect to its folder first.');await this.change({type:'switch_session',sessionPath:ref.sessionPath});}
 async rename(name:string):Promise<void>{await this.pi.request({type:'set_session_name',name});const state=this.store.getSnapshot();if(state.session)this.store.update({session:{...state.session,name}});await this.remember();}
 private async change(command:{type:string;sessionPath?:string}):Promise<void>{if(this.switching)throw new Error('A session change is already in progress.');this.switching=true;try{if(this.store.getSnapshot().run==='running')await this.pi.stopAll();const result=await this.pi.request(command,{timeoutMs:0});if(!result?.cancelled)await this.refresh();}finally{this.switching=false;}}
}
