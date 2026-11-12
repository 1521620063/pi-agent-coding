import { expect, it, vi } from "vitest";
import { HistoryService } from "../../src/features/history";
import { SessionStore } from "../../src/state/session-store";
it("only forks current PI-provided user entries and preserves returned draft without sending", async () => {
  const request = vi.fn(async (cmd: any) =>
    cmd.type === "get_fork_messages"
      ? { messages: [{ entryId: "valid", text: "old prompt" }] }
      : { cancelled: false, text: "old prompt" },
  );
  const refresh = vi.fn(async () => {});
  const store = new SessionStore();
  const history = new HistoryService(
    { request, stopAll: async () => {} } as any,
    store,
    refresh,
  );
  await expect(history.fork("invented")).rejects.toThrow();
  await history.listForkPoints();
  await history.fork("valid");
  expect(store.getSnapshot().editorText?.text).toBe("old prompt");
  expect(request.mock.calls.some(([cmd]) => cmd.type === "prompt")).toBe(false);
  expect(refresh).toHaveBeenCalledOnce();
});
it("does not export when the save dialog is cancelled or refresh after cancelled clone", async () => {
  const request = vi.fn(async () => ({ cancelled: true }));
  const refresh = vi.fn(async () => {});
  const history = new HistoryService(
    { request, stopAll: async () => {} } as any,
    new SessionStore(),
    refresh,
    async () => undefined,
  );
  expect(await history.exportHtml()).toBeUndefined();
  expect(request).not.toHaveBeenCalled();
  await history.clone();
  expect(refresh).not.toHaveBeenCalled();
});

it("maps visible user messages to PI fork points and rejects mismatched branches", async () => {
  const store = new SessionStore();
  store.replaceMessages([{ role: "user", content: "old prompt" }]);
  const request = vi.fn(async (command) =>
    command.type === "get_fork_messages"
      ? { messages: [{ entryId: "point", text: "old prompt" }] }
      : { cancelled: false, text: "old prompt" },
  );
  const history = new HistoryService(
    { request, stopAll: async () => {} } as any,
    store,
    async () => {},
  );
  await history.forkMessage(0);
  expect(request).toHaveBeenCalledWith(
    { type: "fork", entryId: "point" },
    { timeoutMs: 0 },
  );
  expect(store.getSnapshot().editorText?.text).toBe("old prompt");
  store.replaceMessages([{ role: "user", content: "other branch" }]);
  request.mockClear();
  await expect(history.forkMessage(0)).rejects.toThrow("对应");
  expect(request.mock.calls.map(([command]) => command.type)).toEqual([
    "get_fork_messages",
  ]);
});
