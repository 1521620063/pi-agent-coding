import type { ImageContent } from "../pi/protocol";
import type { PiController } from "../pi/controller";
import type { SessionStore } from "../state/session-store";
import type { ViewState } from "../shared/bridge";

type Channel = "steering" | "followUp";
type Queues = ViewState["queues"];
type Entry = { text: string; safe: boolean };
const channels: Channel[] = ["steering", "followUp"];

function readQueues(value: unknown): Queues {
  const result = value as Partial<Queues> | undefined;
  if (
    !result ||
    !channels.every(
      (channel) =>
        Array.isArray(result[channel]) &&
        result[channel]!.every((item) => typeof item === "string"),
    )
  )
    throw new Error("Incompatible PI queue response");
  return { steering: [...result.steering!], followUp: [...result.followUp!] };
}

export class QueueService {
  private known: Record<Channel, Entry[]> = { steering: [], followUp: [] };
  private pending?: Entry & { channel: Channel; used: boolean };
  private signature = "";
  private context = "";
  private revision = 0;
  private publishing = false;
  private operation?: {
    cancelled: boolean;
    replay: AbortController;
    submitting: boolean;
    done?: Promise<void>;
  };
  private unsubscribe: () => void;

  constructor(
    private pi: Pick<PiController, "request">,
    private store: SessionStore,
  ) {
    this.unsubscribe = store.subscribe((state) => this.observe(state));
    this.observe(store.getSnapshot());
  }

  dispose(): void {
    if (this.operation) {
      this.operation.cancelled = true;
      this.operation.replay.abort();
    }
    this.unsubscribe();
  }

  private observe(state: ViewState): void {
    if (this.publishing) return;
    const context = JSON.stringify([
      state.connection,
      state.session?.id,
      state.session?.path,
    ]);
    if (context !== this.context) {
      this.context = context;
      this.known = { steering: [], followUp: [] };
      if (this.operation) {
        this.operation.cancelled = true;
        this.operation.replay.abort();
      }
    }
    const signature = JSON.stringify([context, state.queues]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.revision++;
      for (const channel of channels) {
        const previous = this.known[channel];
        let cursor = 0;
        this.known[channel] = state.queues[channel].map((text) => {
          const index = previous.findIndex(
            (entry, index) => index >= cursor && entry.text === text,
          );
          if (index >= 0) {
            cursor = index + 1;
            // Queue events have no IDs. A consumed duplicate must never inherit
            // the text-only status of an earlier message with the same text.
            return {
              text,
              safe: previous
                .filter((entry) => entry.text === text)
                .every((entry) => entry.safe),
            };
          }
          const pending = this.pending;
          if (
            pending &&
            !pending.used &&
            pending.channel === channel &&
            pending.text === text
          ) {
            pending.used = true;
            return { text, safe: pending.safe };
          }
          return { text, safe: false };
        });
      }
    }
    this.publish();
  }

  private publish(): void {
    const state = this.store.getSnapshot();
    const entries = [...this.known.steering, ...this.known.followUp];
    let reason: string | undefined;
    if (this.operation) reason = "正在调整队列，请稍候。";
    else if (this.pending) reason = "正在发送消息，请稍候。";
    else if (state.connection !== "connected" || state.run !== "running")
      reason = "当前没有运行中的任务。";
    else if (entries.some((entry) => !entry.safe))
      reason = "队列含图片、命令或无法完整恢复的消息，暂不支持引导。";
    else if (
      new Set(entries.map((entry) => entry.text)).size !== entries.length
    )
      reason = "队列含相同文本，无法安全区分要引导的消息。";
    const control = {
      revision: this.revision,
      busy: !!this.operation,
      canSteer: !reason && state.queues.followUp.length > 0,
      ...(reason ? { reason } : {}),
    };
    if (JSON.stringify(control) === JSON.stringify(state.queueControl)) return;
    this.publishing = true;
    try {
      this.store.update({ queueControl: control });
    } finally {
      this.publishing = false;
    }
  }

  async submit(
    message: string,
    images: ImageContent[],
    mode: "steer" | "followUp",
  ): Promise<void> {
    if (this.operation || this.pending)
      throw new Error("正在调整或发送队列消息，请稍候。");
    await this.send(message, images, mode);
  }

  private async send(
    message: string,
    images: ImageContent[],
    mode: "steer" | "followUp",
    signal?: AbortSignal,
  ): Promise<void> {
    this.pending = {
      text: message,
      safe:
        !images.length &&
        !!message.trim() &&
        !message.trimStart().startsWith("/"),
      channel: mode === "steer" ? "steering" : "followUp",
      used: false,
    };
    this.publish();
    try {
      await this.pi.request(
        { type: "prompt", message, images, streamingBehavior: mode },
        { timeoutMs: 0, signal },
      );
    } finally {
      this.pending = undefined;
      this.publish();
    }
  }

  async clear(): Promise<Queues> {
    if (this.operation || this.pending)
      throw new Error("正在调整或发送队列消息，请稍候。");
    return readQueues(await this.pi.request({ type: "clear_queue" }));
  }

  async cancelPromotion(): Promise<boolean> {
    const operation = this.operation;
    if (!operation) return false;
    const uncertain = operation.submitting;
    operation.cancelled = true;
    operation.replay.abort();
    await operation.done?.catch(() => {});
    return uncertain;
  }

  async promote(index: number, revision: number): Promise<void> {
    const state = this.store.getSnapshot();
    if (revision !== this.revision)
      throw new Error("队列已发生变化，请重新选择消息。");
    if (
      !state.queueControl?.canSteer ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= state.queues.followUp.length
    )
      throw new Error(state.queueControl?.reason ?? "此消息已不在后续队列中。");
    const operation = {
      cancelled: false,
      replay: new AbortController(),
      submitting: false,
    } as {
      cancelled: boolean;
      replay: AbortController;
      submitting: boolean;
      done?: Promise<void>;
    };
    this.operation = operation;
    this.publish();
    operation.done = this.move(state, index, operation).finally(() => {
      this.operation = undefined;
      this.publish();
    });
    return operation.done;
  }

  private async move(
    state: ViewState,
    index: number,
    operation: {
      cancelled: boolean;
      replay: AbortController;
      submitting: boolean;
    },
  ): Promise<void> {
    const context = this.context;
    let remaining: { text: string; mode: "steer" | "followUp" }[] = [];
    try {
      const cleared = readQueues(
        await this.pi.request({ type: "clear_queue" }),
      );
      const target = state.queues.followUp[index];
      const targetPresent = cleared.followUp.includes(target);
      // Each returned channel must be a suffix: PI consumes queues in FIFO order.
      const expected = channels.every((channel) => {
        const original = state.queues[channel];
        return (
          cleared[channel].length <= original.length &&
          cleared[channel].every(
            (text, offset) =>
              text ===
              original[original.length - cleared[channel].length + offset],
          )
        );
      });
      remaining = [
        ...cleared.steering.map((text) => ({ text, mode: "steer" as const })),
        ...(targetPresent && expected
          ? [{ text: target, mode: "steer" as const }]
          : []),
        ...cleared.followUp
          .filter((text) => !expected || !targetPresent || text !== target)
          .map((text) => ({ text, mode: "followUp" as const })),
      ];
      if (!expected)
        throw new Error(
          "队列出现未知变化，已取出的文本恢复到输入框，请检查后重新发送。",
        );
      while (remaining.length) {
        if (operation.cancelled || context !== this.context)
          throw new Error("引导已取消。");
        const entry = remaining.shift()!;
        try {
          operation.submitting = true;
          await this.send(entry.text, [], entry.mode, operation.replay.signal);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `${detail}。本条提交结果不确定，未自动重发；请检查对话和队列。`,
          );
        } finally {
          operation.submitting = false;
        }
      }
      if (!targetPresent)
        throw new Error("此消息已开始处理，未重复发送；其他队列消息已恢复。");
    } catch (error) {
      if (remaining.length && context === this.context) {
        const editor = this.store.getSnapshot().editorText;
        this.store.update({
          editorText: {
            text: remaining.map((entry) => entry.text).join("\n\n"),
            append: true,
            revision: (editor?.revision ?? 0) + 1,
          },
        });
      }
      throw error;
    }
  }

  async setMode(
    channel: Channel,
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
