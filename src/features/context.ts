import type { PiController } from "../pi/controller";
import type { SessionStats } from "../pi/protocol";
import type { SessionStore } from "../state/session-store";
export class RetryService {
  constructor(
    private pi: Pick<PiController, "request">,
    private store: SessionStore,
  ) {}
  async setEnabled(enabled: boolean): Promise<void> {
    await this.pi.request({ type: "set_auto_retry", enabled });
    this.store.update({
      retry: { ...this.store.getSnapshot().retry, enabled },
    });
  }
  async cancel(): Promise<void> {
    await this.pi.request({ type: "abort_retry" });
  }
}
export class ContextService {
  private sequence = 0;
  constructor(
    private pi: Pick<PiController, "request">,
    private store: SessionStore,
  ) {}
  async refreshStats(): Promise<void> {
    const id = this.store.getSnapshot().session?.id;
    const sequence = ++this.sequence;
    const stats = await this.pi.request<SessionStats>({
      type: "get_session_stats",
    });
    if (
      this.store.getSnapshot().session?.id === id &&
      sequence === this.sequence
    )
      this.store.update({ stats });
  }
  async compact(customInstructions?: string): Promise<void> {
    const id = this.store.getSnapshot().session?.id;
    this.store.update({
      compaction: {
        ...this.store.getSnapshot().compaction,
        active: true,
        error: undefined,
        notice: undefined,
        result: undefined,
      },
    });
    try {
      const result = await this.pi.request(
        { type: "compact", customInstructions },
        { timeoutMs: 0 },
      );
      if (this.store.getSnapshot().session?.id === id) {
        this.store.update({
          compaction: {
            ...this.store.getSnapshot().compaction,
            active: false,
            result,
          },
        });
        await this.refreshStats();
      }
    } catch (error) {
      // PI may decline a short session; this is not a failed connection or generation.
      const message = error instanceof Error ? error.message : String(error);
      if (/(?:^|: )Nothing to compact \(session too small\)$/.test(message)) {
        if (this.store.getSnapshot().session?.id === id)
          this.store.update({
            compaction: {
              ...this.store.getSnapshot().compaction,
              active: false,
              error: undefined,
              result: undefined,
              notice: "当前会话内容较少，PI 暂无可压缩的上下文，可继续对话。",
            },
          });
        return;
      }
      if (this.store.getSnapshot().session?.id === id)
        this.store.update({
          compaction: {
            ...this.store.getSnapshot().compaction,
            active: false,
            error: String(error),
          },
        });
      throw error;
    }
  }
  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.pi.request({ type: "set_auto_compaction", enabled });
    this.store.update({
      compaction: { ...this.store.getSnapshot().compaction, enabled },
    });
  }
}
