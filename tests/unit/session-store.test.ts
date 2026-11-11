import { expect, it } from "vitest";
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
