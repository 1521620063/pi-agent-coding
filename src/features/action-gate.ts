const transitions = new Set([
  "connect",
  "disconnect",
  "newSession",
  "openSession",
  "selectSession",
  "removeSession",
  "chooseModel",
  "chooseThinking",
  "fork",
  "clone",
  "forkMessage",
  "cycleModel",
  "cycleThinking",
  "promoteQueued",
]);
const blocked = new Set([
  ...transitions,
  "send",
  "compact",
  "shell",
  "renameSession",
  "queueMode",
  "clearQueue",
]);
export class ActionGate {
  private changing = false;
  private transition?: string;
  private stopping = 0;
  async run<T>(type: string, action: () => Promise<T>): Promise<T> {
    if (this.stopping && blocked.has(type))
      throw new Error("正在停止当前任务，请稍候再发送或切换会话。");
    if (type === "stop") {
      this.stopping++;
      try {
        return await action();
      } finally {
        this.stopping--;
      }
    }
    if (this.transition === "connect" && type === "disconnect") return action();
    if (this.changing && blocked.has(type))
      throw new Error(
        "A session transition is in progress. Wait before sending or switching again.",
      );
    if (!transitions.has(type)) return action();
    this.changing = true;
    this.transition = type;
    try {
      return await action();
    } finally {
      this.changing = false;
      this.transition = undefined;
    }
  }
}
