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
    const result = await this.pi.request({ type: "get_fork_messages" });
    if (!Array.isArray(result.messages))
      throw new Error("Incompatible PI fork response");
    this.points = result.messages.filter(
      (point: any) =>
        typeof point.entryId === "string" && typeof point.text === "string",
    );
    this.sessionId = this.store.getSnapshot().session?.id;
    return this.points;
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
    if (!result.cancelled) {
      await this.refresh();
      this.store.update({
        editorText: {
          text: result.text ?? "",
          revision: (this.store.getSnapshot().editorText?.revision ?? 0) + 1,
        },
      });
    }
    this.points = [];
    return result;
  }
  async clone(): Promise<void> {
    await this.idle();
    const result = await this.pi.request({ type: "clone" }, { timeoutMs: 0 });
    if (!result.cancelled) await this.refresh();
  }
  async getTree(): Promise<any> {
    return this.pi.request({ type: "get_tree" });
  }
  async exportHtml(): Promise<string | undefined> {
    const outputPath = await this.savePicker?.();
    if (!outputPath) return;
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
