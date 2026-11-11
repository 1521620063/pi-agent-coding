import { randomUUID } from 'node:crypto';
import type { PiController } from '../pi/controller';
import type { SessionStore } from '../state/session-store';
export class ShellService {
 private activeId?:string;private unsubscribe:()=>void;
 constructor(private pi:Pick<PiController,'request'|'onRecord'>,private store:SessionStore){this.unsubscribe=pi.onRecord(record=>{if(record.type==='bash_execution_update'&&record.id===this.activeId&&typeof record.delta==='string'){const previous=this.store.getSnapshot().shell?.output??'';this.store.update({shell:{id:this.activeId,active:true,output:(previous+record.delta).slice(-200000)}});}});}
 async execute(command:string,excludeFromContext:boolean):Promise<any>{if(this.activeId)throw new Error('A PI shell command is already running.');if(!command.trim())throw new Error('请输入命令。');const id=randomUUID();this.activeId=id;this.store.update({shell:{id,active:true,output:''}});try{const result=await this.pi.request({type:'bash',id,command,excludeFromContext},{timeoutMs:0});const previous=this.store.getSnapshot().shell?.output;this.store.update({shell:{...result,id,active:false,output:(previous||result.output||'').slice(-200000)+(result.truncated?'\n[PI 已截断输出]':'')+(result.fullOutputPath?`\n完整输出：${result.fullOutputPath}`:'')}});return result;}catch(error){this.store.update({shell:{...this.store.getSnapshot().shell,active:false,error:String(error)}});throw error;}finally{this.activeId=undefined;}}
 async cancel():Promise<void>{await this.pi.request({type:'abort_bash'});}
 dispose(){this.unsubscribe();}
}
