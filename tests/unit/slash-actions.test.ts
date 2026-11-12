import { expect, it, vi } from "vitest";
const ui = vi.hoisted(() => ({
  pick: vi.fn(),
  input: vi.fn(),
  info: vi.fn(),
  command: vi.fn(),
}));
vi.mock("vscode", () => ({
  window: {
    showQuickPick: ui.pick,
    showInputBox: ui.input,
    showInformationMessage: ui.info,
  },
  commands: { executeCommand: ui.command },
}));
import { createActionHandler } from "../../src/host/actions";
import { SessionStore } from "../../src/state/session-store";
import { ActionGate } from "../../src/features/action-gate";
import { SessionService } from "../../src/features/sessions";
import { HistoryService } from "../../src/features/history";

function fixture() {
  const store = new SessionStore();
  store.update({ connection: "connected" });
  const sessions = {
    create: vi.fn(async () => {}),
    openFromPicker: vi.fn(async () => {}),
    rename: vi.fn(async (_name: string) => {}),
  };
  const models = {
    refresh: vi.fn(async () => {}),
    select: vi.fn(async (_provider: string, _id: string) => {}),
    setThinking: vi.fn(async (_level: string) => {}),
  };
  const history = {
    clone: vi.fn(async () => {}),
    listForkPoints: vi.fn(async () => [{ text: "question", entryId: "one" }]),
    fork: vi.fn(async (_id: string) => {}),
    getTree: vi.fn(async () => ({ tree: [] })),
    exportHtml: vi.fn(async () => undefined),
  };
  const usage = {
    compact: vi.fn(async (_instructions?: string) => {}),
    refreshStats: vi.fn(async () => {}),
  };
  const queues = {
    submit: vi.fn(async () => {}),
    cancelPromotion: vi.fn(async () => false),
  };
  const controller = { stopAll: vi.fn(async () => {}) };
  const attachments = {
    buildPayload: vi.fn(async () => ({ text: "", images: [] })),
  };
  const post = vi.fn();
  const gate = new ActionGate();
  const handler = createActionHandler({
    store,
    sessions,
    usage,
    queues,
    controller,
    attachments,
    post,
    gate,
    history,
    models,
    commands: { refresh: vi.fn(async () => {}) },
  } as unknown as Parameters<typeof createActionHandler>[0]);
  const send = (text: string, attachmentIds: string[] = []) =>
    handler({ type: "send", text, attachmentIds, mode: "followUp" });
  return {
    store,
    sessions,
    models,
    history,
    usage,
    queues,
    controller,
    attachments,
    post,
    gate,
    send,
  };
}

it("routes /new to session creation rather than model input", async () => {
  const f = fixture();
  await f.send("/new ");
  expect(f.sessions.create).toHaveBeenCalledOnce();
  expect(f.queues.submit).not.toHaveBeenCalled();
  expect(f.post).toHaveBeenCalledWith({ type: "sent", attachmentIds: [] });
});

it("routes /stop through the normal stop handler even during a transition", async () => {
  const f = fixture();
  let finish!: () => void;
  const changing = f.gate.run(
    "chooseModel",
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await f.send("/stop");
  expect(f.controller.stopAll).toHaveBeenCalledOnce();
  expect(f.queues.cancelPromotion).toHaveBeenCalledOnce();
  expect(f.queues.submit).not.toHaveBeenCalled();
  finish();
  await changing;
});

it("does not execute session operations while disconnected", async () => {
  const f = fixture();
  f.store.update({ connection: "disconnected" });
  await expect(f.send("/new")).rejects.toThrow(/连接/);
  expect(f.sessions.create).not.toHaveBeenCalled();
  expect(f.post).not.toHaveBeenCalled();
});

it("opens the existing sidebar model selector", async () => {
  const f = fixture();
  f.store.update({
    models: [{ id: "test-model", provider: "test", input: ["text"] }],
  });
  await f.send("/model");
  expect(f.post).toHaveBeenCalledWith({
    type: "showControl",
    control: "model",
  });
  expect(f.models.select).not.toHaveBeenCalled();
  expect(f.queues.submit).not.toHaveBeenCalled();
});

it("opens the existing sidebar thinking selector", async () => {
  const f = fixture();
  f.store.update({ thinkingLevels: ["off", "high"] });
  await f.send("/thinking");
  expect(f.post).toHaveBeenCalledWith({
    type: "showControl",
    control: "thinking",
  });
});

it("routes resume, name, fork, clone, tree and export without sending model input", async () => {
  const f = fixture();
  await f.send("/resume");
  await f.send("/name 新会话名");
  ui.pick.mockImplementationOnce(async (items) => items[0]);
  await f.send("/fork");
  await f.send("/clone");
  await f.send("/tree");
  await f.send("/export");
  expect(f.post).toHaveBeenCalledWith({
    type: "showControl",
    control: "history",
  });
  expect(f.sessions.openFromPicker).not.toHaveBeenCalled();
  expect(f.sessions.rename).toHaveBeenCalledWith("新会话名");
  expect(f.history.fork).toHaveBeenCalledWith("one");
  expect(f.history.clone).toHaveBeenCalledOnce();
  expect(f.history.getTree).toHaveBeenCalledOnce();
  expect(f.history.exportHtml).toHaveBeenCalledOnce();
  expect(f.queues.submit).not.toHaveBeenCalled();
});

it("does not hijack a command discovered by PI with the same name", async () => {
  const f = fixture();
  f.store.update({ commands: [{ name: "new", source: "extension" }] });
  await f.send("/new existing-argument");
  expect(f.sessions.create).not.toHaveBeenCalled();
  expect(f.queues.submit).toHaveBeenCalledWith(
    "/new existing-argument",
    [],
    "followUp",
  );
});

it("opens sidebar settings and preserves the command when a dialog is cancelled", async () => {
  const f = fixture();
  await f.send("/settings");
  expect(f.post).toHaveBeenCalledWith({
    type: "showControl",
    control: "settings",
  });
  f.post.mockClear();
  ui.pick.mockResolvedValueOnce(undefined);
  await f.send("/fork");
  expect(f.post).toHaveBeenLastCalledWith({
    type: "sent",
    attachmentIds: [],
    preserveDraft: true,
  });
});

it("allows /stop with attachments without acknowledging another pending send", async () => {
  const f = fixture();
  await f.send("/stop", ["file"]);
  expect(f.controller.stopAll).toHaveBeenCalledOnce();
  expect(f.post).toHaveBeenCalledWith({
    type: "commandCompleted",
    text: "/stop",
  });
  expect(f.post).not.toHaveBeenCalledWith({ type: "sent", attachmentIds: [] });
});

it.each([
  ["/compact", undefined],
  ["/compact 保留文件名", "保留文件名"],
])("routes %s to manual compaction", async (text, instructions) => {
  const f = fixture();
  await f.send(text!);
  expect(f.usage.compact).toHaveBeenCalledWith(instructions);
  expect(f.queues.submit).not.toHaveBeenCalled();
  expect(f.post).toHaveBeenCalledWith({ type: "sent", attachmentIds: [] });
});

it("keeps attachments and unsupported arguments instead of silently discarding them", async () => {
  const f = fixture();
  await expect(f.send("/new", ["file"])).rejects.toThrow(/附件/);
  await expect(f.send("/new unexpected")).rejects.toThrow(/参数/);
  expect(f.sessions.create).not.toHaveBeenCalled();
  expect(f.post).not.toHaveBeenCalled();
});

it("preserves the draft when compaction fails or is already active", async () => {
  const f = fixture();
  f.usage.compact.mockRejectedValueOnce(new Error("provider failed"));
  await expect(f.send("/compact")).rejects.toThrow("provider failed");
  f.store.update({ compaction: { active: true } });
  await expect(f.send("/compact")).rejects.toThrow(/压缩/);
  expect(f.usage.compact).toHaveBeenCalledTimes(1);
  expect(f.post).not.toHaveBeenCalled();
});

it("locks /new as a session transition while preserving ordinary slash prompts", async () => {
  const f = fixture();
  let finish!: () => void;
  f.sessions.create.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const creating = f.send("/new");
  await expect(f.send("hello")).rejects.toThrow(/transition/);
  finish();
  await creating;
  await f.send("/skill:review file.ts");
  expect(f.queues.submit).toHaveBeenCalledWith(
    "/skill:review file.ts",
    [],
    "followUp",
  );
});

it.each(["/new", "/fork", "/clone"])(
  "preserves %s when PI cancels the operation",
  async (text) => {
    const f = fixture();
    f.store.update({ session: { id: "old" } });
    const pi = {
      request: vi.fn(async (command: { type: string }) =>
        command.type === "get_fork_messages"
          ? { messages: [{ entryId: "one", text: "question" }] }
          : { cancelled: true },
      ),
      stopAll: async () => {},
    };
    const sessions = new SessionService(pi as never, f.store, {
      get: () => [],
      update: async () => {},
    });
    const history = new HistoryService(pi as never, f.store, async () => {});
    const handler = createActionHandler({
      store: f.store,
      gate: f.gate,
      sessions,
      history,
      post: f.post,
      models: f.models,
      usage: f.usage,
      commands: { refresh: async () => {} },
    } as unknown as Parameters<typeof createActionHandler>[0]);
    if (text === "/fork")
      ui.pick.mockImplementationOnce(async (items) => items[0]);
    await handler({ type: "send", text, attachmentIds: [], mode: "followUp" });
    expect(f.post).toHaveBeenLastCalledWith({
      type: "sent",
      attachmentIds: [],
      preserveDraft: true,
    });
    expect(f.store.getSnapshot().session?.id).toBe("old");
  },
);

it.each(["renameSession", "compact"] as const)(
  "does not apply %s to a session selected while its dialog is open",
  async (type) => {
    const f = fixture();
    f.store.update({ session: { id: "old" } });
    ui.input.mockImplementationOnce(async () => {
      f.store.update({ session: { id: "new" } });
      return "instructions or name";
    });
    const handler = createActionHandler({
      store: f.store,
      gate: f.gate,
      sessions: f.sessions,
      usage: f.usage,
    } as unknown as Parameters<typeof createActionHandler>[0]);
    await expect(handler({ type })).rejects.toThrow(/会话/);
    expect(f.sessions.rename).not.toHaveBeenCalled();
    expect(f.usage.compact).not.toHaveBeenCalled();
  },
);

it("rechecks whether PI is idle after the compaction dialog closes", async () => {
  const f = fixture();
  ui.input.mockImplementationOnce(async () => {
    f.store.update({ run: "running" });
    return "keep filenames";
  });
  const handler = createActionHandler({
    store: f.store,
    gate: f.gate,
    usage: f.usage,
  } as unknown as Parameters<typeof createActionHandler>[0]);
  await expect(handler({ type: "compact" })).rejects.toThrow(/等待/);
  expect(f.usage.compact).not.toHaveBeenCalled();
});
