const transitions = new Set([
  "connect",
  "disconnect",
  "newSession",
  "openSession",
  "sessions",
  "fork",
  "clone",
]);
const blocked = new Set([
  ...transitions,
  "send",
  "chooseModel",
  "chooseThinking",
  "compact",
  "shell",
  "renameSession",
]);
export class ActionGate {
  private changing = false;
  private transition?: string;
  async run<T>(type: string, action: () => Promise<T>): Promise<T> {
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
