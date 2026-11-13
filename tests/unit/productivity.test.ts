import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { SessionStore } from "../../src/state/session-store";
import { QueueService } from "../../src/features/queues";
import { ModelService } from "../../src/features/models";
import { HistoryService } from "../../src/features/history";
import { SessionService } from "../../src/features/sessions";
import { CommandService } from "../../src/features/commands";

it("updates queue modes only after PI accepts the change", async () => {
  const store = new SessionStore();
  const request = vi.fn(async () => ({}));
  await new QueueService({ request } as any, store).setMode("steering", "all");
  expect(request).toHaveBeenCalledWith({
    type: "set_steering_mode",
    mode: "all",
  });
  expect(store.getSnapshot().queueModes?.steering).toBe("all");
  request.mockRejectedValueOnce(new Error("denied"));
  await expect(
    new QueueService({ request } as any, store).setMode(
      "steering",
      "one-at-a-time",
    ),
  ).rejects.toThrow("denied");
  expect(store.getSnapshot().queueModes?.steering).toBe("all");
});

it("cycles models using PI and exposes only presentation fields", async () => {
  const store = new SessionStore();
  const request = vi.fn(async (cmd) =>
    cmd.type === "cycle_model"
      ? {
          model: {
            id: "m",
            provider: "p",
            input: ["text"],
            headers: { secret: "x" },
          },
          thinkingLevel: "high",
        }
      : cmd.type === "get_available_models"
        ? { models: [] }
        : { levels: ["off", "high"] },
  );
  const models = new ModelService({ request } as any, store);
  await models.cycleModel();
  expect(store.getSnapshot().model).toEqual({
    id: "m",
    provider: "p",
    input: ["text"],
  });
  expect(store.getSnapshot().thinkingLevel).toBe("high");
});

it("restores the newest workspace index before remembering the new session", async () => {
  const store = new SessionStore();
  store.update({ workspace: resolve("test-workspace") });
  const request = vi.fn(async (cmd) =>
    cmd.type === "get_state"
      ? { sessionId: "old", sessionFile: "old.jsonl" }
      : cmd.type === "get_messages"
        ? { messages: [] }
        : {},
  );
  const memory = {
    get: () => [
      {
        workspaceUri: pathToFileURL(resolve("test-workspace")).href,
        sessionPath: "old.jsonl",
        sessionId: "old",
        lastOpenedAt: "2026-11-10",
      },
    ],
    update: vi.fn(async () => {}),
  };
  const sessions = new SessionService(
    { request, stopAll: async () => {} } as any,
    store,
    memory,
  );
  expect(await sessions.restoreLast()).toBe(true);
  expect(request.mock.calls[0][0]).toEqual({
    type: "switch_session",
    sessionPath: "old.jsonl",
  });
});

it("searches bounded full history and discards results after a session change", async () => {
  const store = new SessionStore();
  store.update({ session: { id: "one" } });
  const request = vi.fn(async () => ({
    entries: [
      {
        id: "a",
        type: "message",
        message: { role: "user", content: "needle" },
      },
    ],
  }));
  const history = new HistoryService(
    { request, stopAll: async () => {} } as any,
    store,
    async () => {},
  );
  expect(await history.search("needle")).toEqual([
    { entryId: "a", text: "needle" },
  ]);
  request.mockImplementationOnce(async () => {
    store.update({ session: { id: "two" } });
    return { entries: [] };
  });
  await expect(history.search("needle")).rejects.toThrow(/会话/);
});

it("whitelists discovered command metadata", async () => {
  const store = new SessionStore();
  const request = async () => ({
    commands: [
      {
        name: "skill",
        source: "skill",
        sourceInfo: { path: "C:/skill.md", origin: "local", token: "secret" },
        secret: "x",
      },
    ],
  });
  await new CommandService({ request } as any, store).refresh();
  expect(store.getSnapshot().commands).toEqual([
    {
      name: "skill",
      source: "skill",
      sourceInfo: { path: "C:/skill.md", origin: "local" },
    },
  ]);
});
