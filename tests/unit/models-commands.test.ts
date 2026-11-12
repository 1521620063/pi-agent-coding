import { expect, it, vi } from "vitest";
import { ModelService } from "../../src/features/models";
import { CommandService } from "../../src/features/commands";
import { SessionStore } from "../../src/state/session-store";
it("only exposes model presentation fields to the sidebar", async () => {
  const store = new SessionStore();
  const model = {
    id: "private",
    provider: "custom",
    input: ["text"],
    headers: { Authorization: "secret" },
    baseUrl: "private-url",
  };
  const request = vi.fn(async (cmd: any) =>
    cmd.type === "get_available_models"
      ? { models: [model] }
      : cmd.type === "get_available_thinking_levels"
        ? { levels: ["off"] }
        : cmd.type === "set_model"
          ? model
          : { thinkingLevel: "off" },
  );
  const service = new ModelService({ request } as any, store);
  await service.select("custom", "private");
  expect(store.getSnapshot().model).toEqual({
    id: "private",
    provider: "custom",
    input: ["text"],
  });
  expect(JSON.stringify(store.getSnapshot().models)).not.toMatch(
    /secret|private-url/,
  );
});
it("refreshes thinking levels after model selection and preserves state if PI rejects", async () => {
  const store = new SessionStore();
  const request = vi.fn(async (cmd: any) =>
    cmd.type === "set_model"
      ? { id: "new", provider: "test", input: ["text"] }
      : cmd.type === "get_available_thinking_levels"
        ? { levels: ["off", "low"] }
        : { models: [] },
  );
  const service = new ModelService({ request } as any, store);
  await service.select("test", "new");
  expect(store.getSnapshot().thinkingLevels).toEqual(["off", "low"]);
  request.mockRejectedValueOnce(new Error("no model"));
  await expect(service.select("test", "bad")).rejects.toThrow();
  expect(store.getSnapshot().model?.id).toBe("new");
});
it("uses discovered command names verbatim and lets PI expand templates", async () => {
  const request = vi.fn(async (cmd: any) =>
    cmd.type === "get_commands"
      ? {
          commands: [
            { name: "skill:review", source: "skill" },
            { name: "explain", source: "prompt" },
            { name: "ext", source: "extension" },
          ],
        }
      : { disposition: "handled" },
  );
  const store = new SessionStore();
  const service = new CommandService({ request } as any, store);
  await service.refresh();
  await service.invoke("skill:review", "file.ts");
  expect(request).toHaveBeenLastCalledWith(
    {
      type: "prompt",
      message: "/skill:review file.ts",
      streamingBehavior: "followUp",
    },
    { timeoutMs: 0 },
  );
  await expect(service.invoke("settings", "")).rejects.toThrow(/discover/i);
  expect(store.getSnapshot().run).toBe("idle");
});

it("does not overwrite newer model options with a late menu refresh", async () => {
  const store = new SessionStore();
  let finish!: (value: { levels: string[] }) => void;
  let calls = 0;
  const request = vi.fn(async (command: { type: string }) => {
    if (command.type === "get_available_models") return { models: [] };
    if (++calls === 1)
      return new Promise<{ levels: string[] }>((resolve) => {
        finish = resolve;
      });
    return { levels: ["off", "high"] };
  });
  const service = new ModelService({ request } as never, store);
  const old = service.refresh();
  await service.refresh();
  finish({ levels: ["off"] });
  await old;
  expect(store.getSnapshot().thinkingLevels).toEqual(["off", "high"]);
});

it("ignores model options returned after the active session changes", async () => {
  const store = new SessionStore();
  store.update({ session: { id: "old" } });
  let finish!: (value: { levels: string[] }) => void;
  const request = async (command: { type: string }) =>
    command.type === "get_available_models"
      ? { models: [{ id: "old", provider: "test" }] }
      : new Promise<{ levels: string[] }>((resolve) => {
          finish = resolve;
        });
  const service = new ModelService({ request } as never, store);
  const old = service.refresh();
  store.update({ session: { id: "new" }, thinkingLevels: ["high"] });
  finish({ levels: ["off"] });
  await old;
  expect(store.getSnapshot().thinkingLevels).toEqual(["high"]);
  expect(store.getSnapshot().models).toEqual([]);
});

it("does not set the active model from a previous session's late selection", async () => {
  const store = new SessionStore();
  store.update({ session: { id: "old" } });
  const request = vi.fn(async (command: { type: string }) => {
    if (command.type === "set_model") {
      store.update({
        session: { id: "new" },
        model: { id: "new", provider: "test", input: ["text"] },
      });
      return { id: "old", provider: "test" };
    }
    return { models: [], levels: [] };
  });
  await new ModelService({ request } as never, store).select("test", "old");
  expect(store.getSnapshot().model?.id).toBe("new");
  expect(request).toHaveBeenCalledTimes(1);
});

it("ignores commands from an earlier connection after reconnecting", async () => {
  const store = new SessionStore();
  store.update({ connection: "connected" });
  const request = async () => {
    store.update({ connection: "disconnected" });
    store.update({
      connection: "connected",
      commands: [{ name: "new", source: "extension" }],
    });
    return { commands: [{ name: "old", source: "extension" }] };
  };
  await new CommandService({ request } as never, store).refresh();
  expect(store.getSnapshot().commands.map((command) => command.name)).toEqual([
    "new",
  ]);
});

it.each(["setThinking", "cycleThinking", "cycleModel"])(
  "ignores a late %s result after reconnecting to the same session",
  async (operation) => {
    const store = new SessionStore();
    store.update({
      connection: "connected",
      session: { id: "a" },
      thinkingLevels: ["off", "high"],
    });
    const request = vi.fn(async () => {
      store.update({ connection: "disconnected" });
      store.update({
        connection: "connected",
        thinkingLevel: "off",
        model: { id: "new", provider: "test", input: ["text"] },
      });
      return {
        level: "high",
        thinkingLevel: "high",
        model: { id: "old", provider: "test", input: ["text"] },
      };
    });
    const service = new ModelService({ request } as never, store);
    if (operation === "setThinking") await service.setThinking("high");
    else if (operation === "cycleThinking") await service.cycleThinking();
    else await service.cycleModel();
    expect(store.getSnapshot().thinkingLevel).toBe("off");
    expect(store.getSnapshot().model?.id).toBe("new");
    expect(request).toHaveBeenCalledTimes(1);
  },
);
