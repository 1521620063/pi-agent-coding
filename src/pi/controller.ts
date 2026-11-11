import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { assertWorkspace, resolvePiLaunch, type LaunchConfig } from './launcher';
import { createRpcTransport, type RequestOptions, type RpcTransport } from './transport';
import type { ExtensionUiResponse, PiRecord, RpcCommand } from './protocol';
import type { SessionStore } from '../state/session-store';
import type { Unsubscribe } from '../shared/bridge';
interface ControllerConfig extends LaunchConfig { requestTimeoutMs?: number; startupTimeoutMs?: number; shutdownTimeoutMs?: number; trusted?: boolean; remote?: boolean }
export class PiController {
  private child?: ChildProcessWithoutNullStreams;
  private rpc?: RpcTransport;
  private listeners = new Set<(record: PiRecord) => void>();
  private connecting?: Promise<void>;
  private closing = false;
  private diagnostics = '';
  version?: string;
  constructor(private store: SessionStore, private config: ControllerConfig, private log: (text: string) => void = () => {}) {}
  get pid() { return this.child?.pid; }
  configure(config: ControllerConfig) { this.config = {...this.config,...config}; }
  onRecord(listener: (record: PiRecord) => void): Unsubscribe { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  connect(workspaceUri: string): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.start(workspaceUri).finally(() => { this.connecting = undefined; }); return this.connecting;
  }
  private async start(workspaceUri: string) {
    await this.disconnect();
    this.store.update({connection:'connecting',error:undefined}); this.diagnostics = '';
    try {
      const cwd = assertWorkspace({trusted:this.config.trusted !== false,uri:workspaceUri,remote:this.config.remote});
      const launch = await resolvePiLaunch(this.config,{...process.env});
      this.version = await new Promise<string>((resolve,reject) => {
        const child = spawn(launch.command,[...launch.args,'--version'],{env:launch.env,cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
        let output = ''; const timer = setTimeout(() => { void killTree(child); reject(new Error('PI version check timed out')); },this.config.startupTimeoutMs ?? 60000);
        child.stdout.on('data',chunk => { output += chunk.toString(); }); child.stderr.on('data',chunk => this.log(chunk.toString()));
        child.on('error',error => { clearTimeout(timer); reject(error); }); child.on('exit',code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error(`PI version check exited ${code}`)); }); child.stdin.end();
      });
      const child = spawn(launch.command,[...launch.args,'--mode','rpc'],{env:launch.env,cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
      this.child = child; this.closing = false;
      child.stderr.on('data',(chunk: Buffer) => { const message = chunk.toString(); this.diagnostics = (this.diagnostics + message).slice(-12000); this.log(message); });
      const fail = (error: Error) => { if (this.child !== child || this.closing) return; this.rpc?.dispose(); this.store.update({connection:'error',run:'idle',error:`${error.message}\n${this.diagnostics}`.trim()}); };
      child.on('error',fail);
      child.on('exit',(code,signal) => fail(new Error(`PI exited (${code ?? signal}). Reconnect explicitly; prompts will not be replayed.`)));
      this.rpc = createRpcTransport(child,fail);
      this.rpc.onRecord(record => { this.store.apply(record); for (const listener of this.listeners) listener(record); });
      const state = await this.request({type:'get_state'},{timeoutMs:this.config.startupTimeoutMs ?? 60000});
      this.store.update({connection:'connected',workspace:fileURLToPath(workspaceUri),error:undefined});
      this.syncState(state);
    } catch (error) {
      const message = `${error instanceof Error ? error.message : String(error)}\n${this.diagnostics}`.trim();
      await this.disconnect(); this.store.update({connection:'error',error:message}); throw new Error(message);
    }
  }
  syncState(state: any): void {
    if (!state || typeof state.sessionId !== 'string') throw new Error('PI get_state returned incompatible data');
    this.store.update({session:{id:state.sessionId,path:state.sessionFile,name:state.sessionName},model:state.model,thinkingLevel:state.thinkingLevel,run:state.isStreaming ? 'running':'idle',compaction:{...this.store.getSnapshot().compaction,active:!!state.isCompacting,enabled:state.autoCompactionEnabled}});
  }
  request<T = any>(command: RpcCommand, options: RequestOptions = {}): Promise<T> {
    if (!this.rpc) return Promise.reject(new Error('PI is disconnected'));
    return this.rpc.request<T>(command,{timeoutMs:this.config.requestTimeoutMs ?? 10000,...options});
  }
  respond(record: ExtensionUiResponse) { return this.rpc ? this.rpc.send(record) : Promise.reject(new Error('PI is disconnected')); }
  async stopAll(): Promise<void> { await this.request({type:'clear_queue'}); await this.request({type:'abort'}); }
  async disconnect(): Promise<void> {
    this.closing = true; const child = this.child;
    this.rpc?.dispose(); this.rpc = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child,'exit').catch(() => []);
      child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clean = await Promise.race([exited.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false),this.config.shutdownTimeoutMs ?? 5000); })]);
      clearTimeout(timer);
      if (!clean) { await killTree(child); await Promise.race([exited,new Promise(resolve => setTimeout(resolve,1000))]); }
    }
    this.child = undefined; this.store.update({connection:'disconnected',run:'idle',pendingUi:[]}); this.closing = false;
  }
}
async function killTree(child: {pid?: number; kill(signal?: NodeJS.Signals): boolean}) {
  if (!child.pid) return;
  if (process.platform === 'win32') await new Promise<void>(resolve => { const killer = spawn('taskkill.exe',['/pid',String(child.pid),'/T','/F'],{windowsHide:true}); killer.on('error',() => resolve()); killer.on('exit',() => resolve()); });
  else child.kill('SIGKILL');
}
