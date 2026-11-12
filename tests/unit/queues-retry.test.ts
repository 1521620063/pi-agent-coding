import { expect, it, vi } from "vitest";
import { QueueService } from "../../src/features/queues";
import { RetryService } from "../../src/features/context";
import { PiController } from "../../src/pi/controller";
import { SessionStore } from "../../src/state/session-store";
it("clears the queue before abort and never claims all stopped if clearing fails", async () => {
  const controller = new PiController(new SessionStore(), {});
  const request = vi.spyOn(controller, "request").mockResolvedValue({});
  await controller.stopAll();
  expect(request.mock.calls.map(([cmd]) => cmd.type)).toEqual([
    "clear_queue",
    "abort",
  ]);
  request.mockReset().mockRejectedValueOnce(new Error("clear failed"));
  await expect(controller.stopAll()).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});
it("delegates busy prompts and retries to PI without local replays", async () => {
  const store = new SessionStore();
  const request = vi.fn(async () => ({
    disposition: "handled",
    steering: ["one"],
    followUp: ["two"],
  }));
  const queue = new QueueService({ request } as any, store);
  await queue.submit("/ext", [], "steer");
  expect(store.getSnapshot().run).toBe("idle");
  expect(await queue.clear()).toEqual({ steering: ["one"], followUp: ["two"] });
  const retry = new RetryService({ request } as any, store);
  expect(store.getSnapshot().retry.enabled).toBeUndefined();
  await retry.cancel();
  expect(request).toHaveBeenLastCalledWith({ type: "abort_retry" });
});
it("stays running between agent_end, summarization retry and agent_settled", () => {
  const store = new SessionStore();
  store.apply({ type: "agent_start" });
  store.apply({ type: "agent_end" });
  store.apply({ type: "summarization_retry_scheduled", attempt: 1 });
  expect(store.getSnapshot().run).toBe("running");
  store.apply({ type: "summarization_retry_finished" });
  expect(store.getSnapshot().run).toBe("running");
  store.apply({ type: "agent_settled" });
  expect(store.getSnapshot().run).toBe("idle");
});
