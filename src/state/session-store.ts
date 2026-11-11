import type { PiRecord } from '../pi/protocol';
import type { Unsubscribe, ViewState } from '../shared/bridge';
export class SessionStore {
  private state: ViewState = { connection: 'disconnected', run: 'idle', messages: [], tools: [], queues: { steering: [], followUp: [] }, pendingUi: [], attachments: [], models: [], thinkingLevels: [], commands: [], compaction: {}, retry: {}, statuses: {}, widgets: {} };
  private listeners = new Set<(state: ViewState) => void>();
  getSnapshot(): ViewState { return structuredClone(this.state); }
  subscribe(listener: (state: ViewState) => void): Unsubscribe { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  update(patch: Partial<ViewState>): void { Object.assign(this.state, patch); this.emit(); }
  apply(_record: PiRecord): void {}
  private emit(): void { const snapshot = this.getSnapshot(); for (const listener of this.listeners) listener(snapshot); }
}
