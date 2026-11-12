import type { ViewState } from "../shared/bridge";

export class TaskNotifications {
  private session?: string;
  private running = false;
  private waiting = false;
  observe(state: ViewState, foreground: boolean): string | undefined {
    if (this.session !== state.session?.id) {
      this.session = state.session?.id;
      this.running = false;
      this.waiting = false;
    }
    const wasRunning = this.running;
    const wasWaiting = this.waiting;
    this.running = state.run === "running";
    this.waiting = state.pendingUi.length > 0;
    if (foreground) return;
    if (this.waiting && !wasWaiting)
      return "PI 正等待你的输入，请查看 VS Code 交互提示。";
    if (
      wasRunning &&
      !this.running &&
      !state.compaction.active &&
      !state.retry.active
    ) {
      const last = state.messages
        .filter((message) => message.role === "assistant")
        .at(-1);
      return state.error || last?.errorMessage || state.connection === "error"
        ? "PI 任务失败，请打开侧栏查看详情。"
        : "PI 已完成当前任务。";
    }
  }
}
