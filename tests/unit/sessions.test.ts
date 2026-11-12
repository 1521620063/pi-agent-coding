import { expect, it, vi } from "vitest";
import { SessionService } from "../../src/features/sessions";
import { SessionStore } from "../../src/state/session-store";
function setup(cancelled = false) {
  const store = new SessionStore();
  store.update({
    workspace: "C:/work",
    session: { id: "old", path: "old.jsonl" },
    messages: [{ role: "user", content: "old" }],
    run: "running",
  });
  let saved: any[] = [];
  const memory = {
    get: () => saved,
    update: async (_key: string, value: any[]) => {
      saved = value;
    },
  };
  const request = vi.fn(async (cmd: any) =>
    cmd.type === "get_state"
      ? { sessionId: "new", sessionFile: "new.jsonl", thinkingLevel: "low" }
      : cmd.type === "get_messages"
        ? { messages: [{ role: "user", content: "new" }] }
        : { cancelled },
  );
  const pi = { request, stopAll: vi.fn(async () => {}) };
  const sessions = new SessionService(pi as any, store, memory);
  return { store, pi, sessions };
}
it("preserves the old session when PI cancels switching", async () => {
  const { store, sessions, pi } = setup(true);
  await sessions.create();
  expect(store.getSnapshot().session?.id).toBe("old");
  expect(store.getSnapshot().messages[0].content).toBe("old");
  expect(pi.stopAll).toHaveBeenCalledOnce();
});
it("rebuilds the current branch through PI and scopes persisted references by workspace", async () => {
  const { store, sessions } = setup();
  await sessions.create();
  expect(store.getSnapshot().session?.id).toBe("new");
  expect(store.getSnapshot().messages[0].content).toBe("new");
  expect(await sessions.list("file:///C:/work")).toHaveLength(1);
  expect(await sessions.list("file:///C:/elsewhere")).toHaveLength(0);
});

it("publishes and removes only indexed history entries in the current workspace", async () => {
  const { sessions, store, pi } = setup();
  await sessions.remember();
  expect(store.getSnapshot().sessions?.[0].sessionId).toBe("old");
  await expect(sessions.removeFromHistory("unindexed.jsonl")).rejects.toThrow();
  await expect(sessions.selectFromHistory("unindexed.jsonl")).rejects.toThrow();
  await sessions.removeFromHistory("old.jsonl");
  expect(store.getSnapshot().sessions).toEqual([]);
  expect(store.getSnapshot().session?.id).toBe("old");
  expect(pi.request).not.toHaveBeenCalled();
});
