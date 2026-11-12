import { expect, it } from "vitest";
import { SessionStore } from "../../src/state/session-store";

it.each([undefined, null, 42, {}])(
  "ignores a malformed assistant event type (%j) without breaking the session",
  (type) => {
    const store = new SessionStore();
    store.apply({ type: "agent_start" });
    expect(() =>
      store.apply({
        type: "message_update",
        assistantMessageEvent: { contentIndex: 0, type },
      }),
    ).not.toThrow();
    store.apply({
      type: "message_end",
      message: { role: "assistant", content: "still connected" },
    });
    expect(store.getSnapshot().messages).toEqual([
      { role: "assistant", content: "still connected" },
    ]);
    expect(store.getSnapshot().run).toBe("running");
  },
);

it("filters invalid history messages before rebuilding tools and rendering", () => {
  const store = new SessionStore();
  expect(() =>
    store.replaceMessages([
      null,
      { role: "user", content: "valid message" },
      { content: "missing role" },
      { role: "assistant", content: null },
    ] as never),
  ).not.toThrow();
  expect(store.getSnapshot().messages).toEqual([
    { role: "user", content: "valid message" },
  ]);
});
