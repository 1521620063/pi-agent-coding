import type { PiController } from "../pi/controller";
import type { SessionStore } from "../state/session-store";
export interface ForkPoint {
  entryId: string;
  text: string;
}
export class HistoryService {
  private points: ForkPoint[] = [];
  private sessionId?: string;
  constructor(
    private pi: Pick<PiController, "request" | "stopAll">,
    private store: SessionStore,
    private refresh: () => Promise<void>,
    private savePicker?: () => Promise<string | undefined>,
  ) {}
  async listForkPoints(): Promise<ForkPoint[]> {
    const sessionId = this.store.getSnapshot().session?.id;
    const result = await this.pi.request({ type: "get_fork_messages" });
    if (this.store.getSnapshot().session?.id !== sessionId)
      throw new Error("会话已切换，请重试。");
    if (!Array.isArray(result.messages))
      throw new Error("Incompatible PI fork response");
    this.points = result.messages.filter(
      (point: any) =>
        typeof point.entryId === "string" && typeof point.text === "string",
    );
    this.sessionId = sessionId;
    return this.points;
  }
  async forkMessage(index: number): Promise<void> {
    const messages = this.store.getSnapshot().messages;
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      messages[index]?.role !== "user"
    )
      throw new Error("请选择当前会话中的用户消息。");
    const ordinal =
      messages.slice(0, index + 1).filter((message) => message.role === "user")
        .length - 1;
    const points = await this.listForkPoints();
    // Only map when PI's branch and the visible branch agree, including message text.
    const users = messages.filter((message) => message.role === "user");
    const textOf = (content: (typeof messages)[number]["content"]) =>
      typeof content === "string"
        ? content
        : content
            .filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .join("\n");
    if (
      users.length !== points.length ||
      !points[ordinal] ||
      textOf(messages[index].content) !== points[ordinal].text
    )
      throw new Error(
        "当前消息无法与 PI 分叉点对应，请使用更多操作中的分叉菜单。",
      );
    await this.fork(points[ordinal].entryId);
  }
  async search(query: string): Promise<ForkPoint[]> {
    if (!query.trim()) return [];
    const sessionId = this.store.getSnapshot().session?.id;
    const result = await this.pi.request({ type: "get_entries" });
    if (this.store.getSnapshot().session?.id !== sessionId)
      throw new Error("会话已切换，请重试搜索。");
    if (!Array.isArray(result.entries))
      throw new Error("此 PI 未返回完整历史条目。");
    const matches: ForkPoint[] = [];
    for (const entry of result.entries) {
      if (entry?.type !== "message" || typeof entry.id !== "string") continue;
      const content = entry.message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter(
                  (block) =>
                    block?.type === "text" && typeof block.text === "string",
                )
                .map((block) => block.text)
                .join("\n")
            : "";
      const position = text
        .toLocaleLowerCase()
        .indexOf(query.toLocaleLowerCase());
      if (position < 0) continue;
      const start = Math.max(0, position - 400);
      matches.push({
        entryId: entry.id,
        text:
          (start ? "…" : "") +
          text.slice(start, start + 4000) +
          (text.length > start + 4000 ? "…（插件预览截断）" : ""),
      });
      if (matches.length >= 100) break;
    }
    return matches;
  }
  async fork(entryId: string): Promise<{ text?: string; cancelled: boolean }> {
    if (
      this.sessionId !== this.store.getSnapshot().session?.id ||
      !this.points.some((point) => point.entryId === entryId)
    )
      throw new Error("Fork point is not in the current PI branch.");
    await this.idle();
    const result = await this.pi.request(
      { type: "fork", entryId },
      { timeoutMs: 0 },
    );
    this.points = [];
    if (!result.cancelled) {
      this.store.update({
        editorText: {
          text: result.text ?? "",
          revision: (this.store.getSnapshot().editorText?.revision ?? 0) + 1,
          focus: true,
        },
      });
      await this.refresh();
    }
    return result;
  }
  async clone(): Promise<boolean> {
    await this.idle();
    const result = await this.pi.request({ type: "clone" }, { timeoutMs: 0 });
    if (!result.cancelled) await this.refresh();
    return !result.cancelled;
  }
  async getTree(): Promise<any> {
    return this.pi.request({ type: "get_tree" });
  }
  async exportHtml(): Promise<string | undefined> {
    const revision = this.store.sessionRevision;
    const outputPath = await this.savePicker?.();
    if (!outputPath) return;
    if (revision !== this.store.sessionRevision)
      throw new Error("会话已切换或连接已改变，请重新导出。");
    const result = await this.pi.request(
      { type: "export_html", outputPath },
      { timeoutMs: 0 },
    );
    if (typeof result.path !== "string")
      throw new Error("PI did not return an export path.");
    return result.path;
  }
  private async idle() {
    if (this.store.getSnapshot().run === "running") await this.pi.stopAll();
  }
}
