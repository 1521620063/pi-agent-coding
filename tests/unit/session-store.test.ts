import { expect, it, vi } from "vitest";
import { SessionStore } from "../../src/state/session-store";
it("reconciles partial text and thinking with authoritative message_end", () => {
  const store = new SessionStore();
  store.apply({ type: "agent_start" });
  store.apply({
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  store.apply({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "hel",
    },
  });
  store.apply({
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 1,
      delta: "think",
    },
  });
  expect(store.getSnapshot().messages[0].content).toEqual([
    { type: "text", text: "hel" },
    { type: "thinking", thinking: "think" },
  ]);
  store.apply({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  });
  expect(store.getSnapshot().messages).toHaveLength(1);
  expect(store.getSnapshot().messages[0].content).toEqual([
    { type: "text", text: "hello" },
  ]);
  store.apply({ type: "agent_end", willRetry: true });
  expect(store.getSnapshot().run).toBe("running");
  store.apply({ type: "agent_settled" });
  expect(store.getSnapshot().run).toBe("idle");
});
it("replaces queues and merges generic tool results without assuming tool names", () => {
  const store = new SessionStore();
  store.apply({ type: "queue_update", steering: ["one"], followUp: ["two"] });
  store.apply({ type: "queue_update", steering: [], followUp: ["three"] });
  expect(store.getSnapshot().queues).toEqual({
    steering: [],
    followUp: ["three"],
  });
  store.apply({
    type: "tool_execution_start",
    toolCallId: "mcp1",
    toolName: "mcp_search",
    args: {},
  });
  store.apply({
    type: "tool_execution_end",
    toolCallId: "mcp1",
    toolName: "mcp_search",
    isError: true,
    result: { content: [{ type: "text", text: "bad" }] },
  });
  expect(store.getSnapshot().tools[0]).toMatchObject({
    name: "mcp_search",
    status: "error",
  });
});

it("keeps business subscriptions synchronous without cloning unrelated streaming content", () => {
  const store = new SessionStore();
  const observe = vi.fn();
  store.subscribe(observe, ["connection", "run", "queues"]);
  const snapshot = vi.spyOn(store, "getSnapshot");
  for (let i = 0; i < 100; i++)
    store.apply({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "字",
      },
    });
  expect(observe).not.toHaveBeenCalled();
  expect(snapshot).not.toHaveBeenCalled();
  store.apply({ type: "agent_start" });
  expect(observe).toHaveBeenLastCalledWith(
    expect.objectContaining({ run: "running" }),
  );
  store.apply({ type: "queue_update", steering: [], followUp: ["queued"] });
  expect(observe).toHaveBeenLastCalledWith(
    expect.objectContaining({ queues: { steering: [], followUp: ["queued"] } }),
  );
  store.apply({ type: "agent_settled" });
  expect(observe).toHaveBeenLastCalledWith(
    expect.objectContaining({ run: "idle" }),
  );
});

it("notifies snapshot-free observers and stops after unsubscribe", () => {
  const store = new SessionStore();
  const changed = vi.fn();
  const stop = store.subscribeChanges(changed);
  const snapshot = vi.spyOn(store, "getSnapshot");
  store.update({ title: "new title" });
  expect(changed).toHaveBeenCalledOnce();
  expect(snapshot).not.toHaveBeenCalled();
  stop();
  store.update({ title: "later" });
  expect(changed).toHaveBeenCalledOnce();
});
