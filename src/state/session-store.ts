import { isObject, type PiRecord, type AgentMessage, type JsonObject } from '../pi/protocol';
import type { Unsubscribe, ViewState } from '../shared/bridge';
export class SessionStore {
  private state: ViewState = { connection: 'disconnected', run: 'idle', messages: [], tools: [], queues: { steering: [], followUp: [] }, pendingUi: [], attachments: [], models: [], thinkingLevels: [], commands: [], compaction: {}, retry: {}, statuses: {}, widgets: {} };
  private listeners = new Set<(state: ViewState) => void>();
  private activeMessage: number | undefined;
  getSnapshot(): ViewState { return structuredClone(this.state); }
  subscribe(listener: (state: ViewState) => void): Unsubscribe { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  update(patch: Partial<ViewState>): void { Object.assign(this.state, patch); this.emit(); }
  replaceMessages(messages: AgentMessage[]): void { this.activeMessage = undefined; this.state.messages = structuredClone(messages); this.state.tools = [];
    for (const message of messages) if (message.role === 'toolResult' && typeof message.toolCallId === 'string') this.state.tools.push({id:message.toolCallId,name:message.toolName ?? 'tool',args:{},result:{content:message.content,details:message.details},status:message.isError ? 'error':'success'});
    this.emit();
  }
  apply(record: PiRecord): void {
    const state = this.state;
    switch (record.type) {
      case 'agent_start': state.run = 'running'; break;
      case 'agent_settled': state.run = 'idle'; state.retry = {...state.retry,active:false}; break;
      case 'message_start':
        if (!validMessage(record.message)) return;
        this.activeMessage = state.messages.length; state.messages.push(structuredClone(record.message)); break;
      case 'message_update': {
        const event = record.assistantMessageEvent; if (!isObject(event) || !Number.isInteger(event.contentIndex) || event.contentIndex < 0 || event.contentIndex > 10000) return;
        if (this.activeMessage === undefined) { this.activeMessage = state.messages.length; state.messages.push({role:'assistant',content:[]}); }
        const message = state.messages[this.activeMessage]; if (message.role !== 'assistant') return;
        if (!Array.isArray(message.content)) message.content = [];
        const index = event.contentIndex;
        if (event.type.startsWith('text_')) {
          const old = message.content[index]; message.content[index] = {type:'text',text:event.type === 'text_end' ? event.content : (old?.text ?? '') + (event.delta ?? '')};
        } else if (event.type.startsWith('thinking_')) {
          const old = message.content[index]; message.content[index] = {type:'thinking',thinking:event.type === 'thinking_end' ? event.content : (old?.thinking ?? '') + (event.delta ?? '')};
        } else if (event.type === 'toolcall_start') message.content[index] = {type:'toolCall',id:event.id,name:event.toolName,arguments:{}};
        else if (event.type === 'toolcall_end' && isObject(event.toolCall)) message.content[index] = event.toolCall;
        if (record.usage) message.usage = record.usage;
        break;
      }
      case 'message_end':
        if (!validMessage(record.message)) return;
        if (this.activeMessage !== undefined) state.messages[this.activeMessage] = structuredClone(record.message);
        else state.messages.push(structuredClone(record.message));
        this.activeMessage = undefined; break;
      case 'tool_execution_start': case 'tool_execution_update': case 'tool_execution_end': {
        if (typeof record.toolCallId !== 'string' || typeof record.toolName !== 'string') return;
        let tool = state.tools.find(tool => tool.id === record.toolCallId);
        if (!tool) { tool = {id:record.toolCallId,name:record.toolName,args:isObject(record.args) ? record.args : {},status:'pending'}; state.tools.push(tool); }
        if (isObject(record.partialResult)) tool.result = record.partialResult;
        if (record.type === 'tool_execution_end') { tool.result = isObject(record.result) ? record.result : {}; tool.status = record.isError ? 'error':'success'; tool.durationMs = record.durationMs; }
        break;
      }
      case 'queue_update': if (strings(record.steering) && strings(record.followUp)) state.queues = {steering:record.steering,followUp:record.followUp}; break;
      case 'session_info_changed': if (state.session) state.session.name = typeof record.name === 'string' ? record.name : undefined; break;
      case 'thinking_level_changed': state.thinkingLevel = record.level; break;
      case 'auto_retry_start': case 'summarization_retry_scheduled': case 'summarization_retry_attempt_start': state.run = 'running'; state.retry = {...state.retry,...record,active:true}; break;
      case 'auto_retry_end': case 'summarization_retry_finished': state.retry = {...state.retry,...record,active:false}; break;
      case 'compaction_start': state.compaction = {...state.compaction,active:true,reason:record.reason,error:undefined}; break;
      case 'compaction_end': state.compaction = {...state.compaction,active:false,result:record.result,error:record.errorMessage,aborted:record.aborted}; if (record.willRetry) state.run = 'running'; break;
      case 'extension_error': state.error = String(record.error ?? 'PI extension error'); break;
      default: return;
    }
    this.emit();
  }
  private emit(): void { const snapshot = this.getSnapshot(); for (const listener of this.listeners) listener(snapshot); }
}
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string'); }
function validMessage(value: unknown): value is AgentMessage { return isObject(value) && typeof value.role === 'string' && (typeof value.content === 'string' || Array.isArray(value.content)); }
