// @vitest-environment jsdom
import { expect, it } from "vitest";
import { renderChat } from "../../webview/chat";
import { SessionStore } from "../../src/state/session-store";

function fixture() {
  const state = new SessionStore().getSnapshot();
  state.connection = "connected";
  state.session = { id: "one", path: "one.jsonl" };
  state.messages = [
    { role: "user", content: "earlier question" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reason" },
        { type: "text", text: "earlier answer" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "stream" },
        { type: "toolCall", id: "tool", name: "custom" },
      ],
    },
  ];
  state.tools = [{ id: "tool", name: "custom", args: {}, status: "pending" }];
  const container = document.createElement("div");
  document.body.append(container);
  renderChat(container, state);
  return { state, container };
}

it("retains historical nodes, focus, selection and expanded thinking across cloned streaming snapshots", () => {
  const { state, container } = fixture();
  const historical = container.children[1];
  const thinking = historical.querySelector("details")!;
  thinking.open = true;
  const copy = historical.querySelector<HTMLButtonElement>("button")!;
  copy.focus();
  const range = document.createRange();
  range.selectNodeContents(historical.querySelector(".markdown p")!);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const next = structuredClone(state);
  next.messages[2].content = [
    { type: "text", text: "streaming" },
    { type: "toolCall", id: "tool", name: "custom" },
  ];
  renderChat(container, next);
  expect(container.children[1] === historical).toBe(true);
  expect(document.activeElement === copy).toBe(true);
  expect(selection.toString()).toBe("earlier answer");
  expect(thinking.open).toBe(true);
  expect(container.lastElementChild?.textContent).toContain("streaming");
});

it("updates tool output without replacing its assistant text or closed/open state", () => {
  const { state, container } = fixture();
  const assistant = container.children[2];
  const markdown = assistant.querySelector(".markdown");
  const tool = assistant.querySelector("details")!;
  tool.open = true;
  state.tools[0] = {
    ...state.tools[0],
    status: "success",
    result: { content: [{ type: "text", text: "finished" }] },
  };
  renderChat(container, structuredClone(state));
  expect(container.children[2] === assistant).toBe(true);
  expect(assistant.querySelector(".markdown") === markdown).toBe(true);
  expect(assistant.querySelector("details") === tool).toBe(true);
  expect(tool.open).toBe(true);
  expect(tool.textContent).toContain("finished");
});

it("does not mutate chat DOM for unrelated state changes", () => {
  const { state, container } = fixture();
  const observer = new MutationObserver(() => {});
  observer.observe(container, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
  renderChat(container, {
    ...structuredClone(state),
    title: "renamed",
    stats: { cost: 1 },
  });
  expect(observer.takeRecords()).toHaveLength(0);
  observer.disconnect();
});

it("keeps matching nodes during search and invalidates nodes on session changes", () => {
  const { state, container } = fixture();
  const historical = container.children[1];
  renderChat(container, structuredClone(state), "earlier answer");
  expect(container.firstElementChild === historical).toBe(true);
  renderChat(container, structuredClone(state));
  expect(container.children[1] === historical).toBe(true);
  const next = structuredClone(state);
  next.session = { id: "two", path: "two.jsonl" };
  renderChat(container, next);
  expect(container.children[1] === historical).toBe(false);
});

it("uses authoritative snapshots after truncation, disconnection and message replacement", () => {
  const { state, container } = fixture();
  state.messages[2] = { role: "assistant", content: "authoritative" };
  state.tools = [];
  renderChat(container, structuredClone(state));
  expect(container.textContent).toContain("authoritative");
  expect(container.textContent).not.toContain("stream");
  expect(container.querySelector(".tool")).toBeNull();
  state.connection = "disconnected";
  renderChat(container, structuredClone(state));
  expect(
    container.querySelector<HTMLButtonElement>("[data-message-index]")
      ?.disabled,
  ).toBe(true);
  state.messages = state.messages.slice(0, 1);
  renderChat(container, structuredClone(state));
  expect(container.children).toHaveLength(1);
  state.messages = [];
  renderChat(container, structuredClone(state));
  expect(container.querySelector(".empty")).not.toBeNull();
});

it("keeps standalone tools visible, then moves them into their call without duplication", () => {
  const { state, container } = fixture();
  state.tools.push({
    id: "orphan",
    name: "unknown",
    args: {},
    status: "pending",
  });
  renderChat(container, structuredClone(state));
  const orphan = container.querySelector('[data-key="tool-orphan"]');
  state.messages.push({
    role: "assistant",
    content: [{ type: "toolCall", id: "orphan" }],
  });
  renderChat(container, structuredClone(state));
  expect(container.querySelectorAll('[data-key="tool-orphan"]')).toHaveLength(
    1,
  );
  expect(container.lastElementChild?.contains(orphan)).toBe(true);
});
