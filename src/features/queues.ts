import type { ImageContent } from "../pi/protocol";
import type { PiController } from "../pi/controller";
import type { SessionStore } from "../state/session-store";
export class QueueService {
  constructor(
    private pi: Pick<PiController, "request">,
    private store: SessionStore,
  ) {}
  async submit(
    message: string,
    images: ImageContent[],
    mode: "steer" | "followUp",
  ): Promise<void> {
    await this.pi.request(
      { type: "prompt", message, images, streamingBehavior: mode },
      { timeoutMs: 0 },
    );
  }
  async clear(): Promise<{ steering: string[]; followUp: string[] }> {
    const result = await this.pi.request({ type: "clear_queue" });
    if (!Array.isArray(result?.steering) || !Array.isArray(result?.followUp))
      throw new Error("Incompatible PI queue response");
    this.store.update({ queues: { steering: [], followUp: [] } });
    return { steering: result.steering, followUp: result.followUp };
  }
  async setMode(
    channel: "steering" | "followUp",
    mode: "all" | "one-at-a-time",
  ): Promise<void> {
    const session = this.store.getSnapshot().session?.id;
    await this.pi.request({
      type: channel === "steering" ? "set_steering_mode" : "set_follow_up_mode",
      mode,
    });
    if (this.store.getSnapshot().session?.id !== session) return;
    this.store.update({
      queueModes: { ...this.store.getSnapshot().queueModes, [channel]: mode },
    });
  }
}
