import { expect, it, vi } from "vitest";
import { ContextService } from "../../src/features/context";
import { RetryService } from "../../src/features/context";
import { SessionStore } from "../../src/state/session-store";
it("retains unknown context usage and zero cost without inventing a value", async () => {
  const store = new SessionStore();
  const service = new ContextService(
    {
      request: async () => ({
        cost: 0,
        contextUsage: { tokens: null, percent: null, contextWindow: 100 },
      }),
    } as any,
    store,
  );
  await service.refreshStats();
  expect(store.getSnapshot().stats).toMatchObject({
    cost: 0,
    contextUsage: { tokens: null, percent: null },
  });
});
it("ignores late statistics from a previous session", async () => {
  const store = new SessionStore();
  store.update({ session: { id: "a" } });
  let done!: (value: any) => void;
  const request = () =>
    new Promise((resolve) => {
      done = resolve;
    });
  const service = new ContextService({ request } as any, store);
  const refreshing = service.refreshStats();
  store.update({ session: { id: "b" } });
  done({ cost: 12 });
  await refreshing;
  expect(store.getSnapshot().stats).toBeUndefined();
});
it("uses a long-running compact request and clears active state on failure", async () => {
  const store = new SessionStore();
  const request = vi.fn(async () => {
    throw new Error("compact failed");
  });
  const service = new ContextService({ request } as any, store);
  await expect(service.compact("keep filenames")).rejects.toThrow();
  expect(request).toHaveBeenCalledWith(
    { type: "compact", customInstructions: "keep filenames" },
    { timeoutMs: 0 },
  );
  expect(store.getSnapshot().compaction.active).toBe(false);
});

it("treats PI's nothing-to-compact response as information without a global error", async () => {
  const store = new SessionStore();
  store.update({ compaction: { result: { summary: "old summary" } } });
  const request = vi
    .fn()
    .mockRejectedValueOnce(
      new Error(
        "PI compact (request-id): Nothing to compact (session too small)",
      ),
    );
  const service = new ContextService({ request }, store);
  await expect(service.compact()).resolves.toBeUndefined();
  expect(store.getSnapshot().compaction).toMatchObject({
    active: false,
    notice: "当前会话内容较少，PI 暂无可压缩的上下文，可继续对话。",
  });
  expect(store.getSnapshot().compaction.error).toBeUndefined();
  expect(store.getSnapshot().compaction.result).toBeUndefined();
  expect(store.getSnapshot().error).toBeUndefined();
  request.mockRejectedValueOnce(new Error("provider unavailable"));
  await expect(service.compact()).rejects.toThrow("provider unavailable");
  expect(store.getSnapshot().compaction.notice).toBeUndefined();
});

it("ignores a late nothing-to-compact response after switching sessions", async () => {
  const store = new SessionStore();
  store.update({ session: { id: "a" } });
  let reject!: (error: Error) => void;
  const service = new ContextService(
    {
      request: <T>() =>
        new Promise<T>((_, fail) => {
          reject = fail;
        }),
    },
    store,
  );
  const compacting = service.compact();
  store.update({ session: { id: "b" }, compaction: {} });
  reject(
    new Error(
      "PI compact (request-id): Nothing to compact (session too small)",
    ),
  );
  await compacting;
  expect(store.getSnapshot().compaction).toEqual({});
});

it("ignores late statistics after leaving and returning to the same session", async () => {
  const store = new SessionStore();
  store.update({ session: { id: "a" } });
  let finish!: (stats: { cost: number }) => void;
  const service = new ContextService(
    {
      request: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    } as never,
    store,
  );
  const refreshing = service.refreshStats();
  store.update({ session: { id: "b" } });
  store.update({ session: { id: "a" }, stats: { cost: 2 } });
  finish({ cost: 1 });
  await refreshing;
  expect(store.getSnapshot().stats?.cost).toBe(2);
});

it.each(["compact", "autoCompaction", "autoRetry"])(
  "ignores a late %s result after reconnecting to the same session",
  async (operation) => {
    const store = new SessionStore();
    store.update({ connection: "connected", session: { id: "a" } });
    let finish!: (result: object) => void;
    const pi = {
      request: (command: { type: string }) =>
        command.type === "get_session_stats"
          ? Promise.resolve({ cost: 1 })
          : new Promise((resolve) => {
              finish = resolve;
            }),
    };
    const context = new ContextService(pi as never, store);
    const retry = new RetryService(pi as never, store);
    const pending =
      operation === "compact"
        ? context.compact()
        : operation === "autoCompaction"
          ? context.setAutoCompaction(true)
          : retry.setEnabled(true);
    store.update({ connection: "disconnected" });
    store.update({ connection: "connected", compaction: {}, retry: {} });
    finish({ summary: "old summary" });
    await pending;
    expect(store.getSnapshot().compaction).toEqual({});
    expect(store.getSnapshot().retry).toEqual({});
  },
);
