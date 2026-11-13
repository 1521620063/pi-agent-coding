// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { SessionStore } from "../../src/state/session-store";
import { renderChat, updateActivityElapsed } from "../../webview/chat";

function fixture() {
  const store = new SessionStore();
  store.update({ connection: "connected", session: { id: "live" } });
  store.replaceMessages([{ role: "user", content: "检查项目" }]);
  const container = document.createElement("div");
  document.body.append(container);
  const render = () => renderChat(container, store.getSnapshot());
  store.apply({ type: "agent_start" });
  render();
  return { store, container, render };
}
function thinking(store: SessionStore, text = "核对配置与入口") {
  store.apply({
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  store.apply({
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: text,
    },
  });
}
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

it("shows waiting immediately, previews actual thinking, and withdraws it at thinking_end", () => {
  const { store, container, render } = fixture();
  const execution = container.querySelector<HTMLDetailsElement>(".execution")!;
  expect(execution).not.toBeNull();
  expect(execution.open).toBe(false);
  expect(execution.querySelector(".execution-label")?.textContent).toBe(
    "Waiting",
  );
  thinking(store, "检查 <script> 原始文本");
  render();
  expect(container.querySelector(".execution")).toBe(execution);
  const preview = execution.querySelector<HTMLElement>(".execution-preview")!;
  expect(preview.hidden).toBe(false);
  expect(preview.textContent).toContain("检查 <script> 原始文本");
  expect(preview.querySelector("script")).toBeNull();
  expect(execution.querySelector(".execution-label")?.textContent).toBe(
    "Thinking",
  );
  store.apply({
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_end",
      contentIndex: 0,
      content: "检查 <script> 原始文本",
    },
  });
  render();
  expect(preview.hidden).toBe(true);
  store.apply({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 1,
      delta: "这是回复",
    },
  });
  render();
  expect(execution.querySelector(".execution-label")?.textContent).toBe(
    "Writing",
  );
  expect(
    container.querySelector(":scope > .assistant-message")?.textContent,
  ).toContain("这是回复");
  expect(preview.hidden).toBe(true);
  store.apply({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "检查 <script> 原始文本" },
        { type: "text", text: "完整回复" },
      ],
    },
  });
  store.apply({ type: "agent_end" });
  render();
  expect(execution.classList.contains("is-running")).toBe(true);
  store.apply({ type: "agent_settled" });
  render();
  expect(container.querySelector(".execution")).toBeNull();
  expect(container.textContent).toContain("完整回复");
});

it("switches to bounded tool output, folds on settlement, and retains full history", () => {
  const { store, container, render } = fixture();
  thinking(store);
  render();
  store.apply({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "核对配置与入口" },
        {
          type: "toolCall",
          id: "check",
          name: "bash",
          arguments: { command: "npm run check" },
        },
      ],
    },
  });
  store.apply({
    type: "tool_execution_start",
    toolCallId: "check",
    toolName: "bash",
    args: { command: "npm run check" },
  });
  store.apply({
    type: "tool_execution_update",
    toolCallId: "check",
    toolName: "bash",
    partialResult: {
      content: [{ type: "text", text: "输出\n".repeat(1000) + "最新进度" }],
    },
  });
  render();
  const execution = container.querySelector<HTMLDetailsElement>(".execution")!;
  const preview = execution.querySelector<HTMLElement>(".execution-preview")!;
  expect(execution.querySelector(".execution-current")?.textContent).toContain(
    "运行命令",
  );
  expect(preview.hidden).toBe(false);
  expect(preview.textContent).toContain("最新进度");
  expect(preview.textContent!.length).toBeLessThanOrEqual(601);
  store.apply({
    type: "tool_execution_end",
    toolCallId: "check",
    toolName: "bash",
    result: {
      content: [{ type: "text", text: "检查通过" }],
    },
  });
  render();
  expect(execution.classList.contains("is-running")).toBe(true);
  expect(preview.hidden).toBe(true);
  store.apply({ type: "agent_settled" });
  render();
  expect(execution.open).toBe(false);
  expect(execution.classList.contains("is-running")).toBe(false);
  expect(execution.querySelector(".execution-label")?.textContent).toBe(
    "Activity",
  );
  expect(execution.querySelector(".tool-output")?.textContent).toBe("检查通过");
});

it("respects manual expansion and collapse through updates and settlement", async () => {
  const { store, container, render } = fixture();
  thinking(store);
  render();
  const execution = container.querySelector<HTMLDetailsElement>(".execution")!;
  execution.open = true;
  execution.dispatchEvent(new Event("toggle"));
  render();
  expect(execution.open).toBe(true);
  execution.open = false;
  execution.dispatchEvent(new Event("toggle"));
  thinking(store, "新一段思考");
  render();
  expect(execution.open).toBe(false);
  expect(
    execution.querySelector<HTMLElement>(".execution-preview")?.hidden,
  ).toBe(true);
  execution.open = true;
  execution.dispatchEvent(new Event("toggle"));
  store.apply({ type: "agent_settled" });
  render();
  expect(execution.open).toBe(true);
});

it("keeps interaction, retry, compaction and disconnection visible without old thinking", () => {
  const { store, container, render } = fixture();
  thinking(store);
  for (const [patch, label] of [
    [{ pendingUi: [{ id: "confirm" }] }, "Input needed"],
    [{ pendingUi: [], retry: { active: true, attempt: 2 } }, "Retrying"],
    [{ retry: {}, compaction: { active: true } }, "Compacting"],
    [{ compaction: {}, connection: "disconnected" }, "Interrupted"],
  ] as const) {
    store.update(
      structuredClone(patch) as Parameters<SessionStore["update"]>[0],
    );
    render();
    expect(container.querySelector(".execution-label")?.textContent).toBe(
      label,
    );
    expect(
      container.querySelector<HTMLElement>(".execution-preview")?.hidden,
    ).toBe(true);
  }
  expect(container.querySelector(".execution.is-running")).toBeNull();
});

it("keeps a disconnect visible after the controller also resets run to idle", () => {
  const { store, container, render } = fixture();
  thinking(store);
  render();
  store.update({ connection: "disconnected", run: "idle" });
  render();
  render();
  expect(container.querySelector(".execution-label")?.textContent).toBe(
    "Interrupted",
  );
  expect(container.querySelector(".execution.is-running")).toBeNull();
  expect(
    container.querySelector<HTMLElement>(".execution-preview")?.hidden,
  ).toBe(true);
  expect(store.getSnapshot().generation).toBeUndefined();
});

it("stops preview and animation at settlement even if a tool has no end event", () => {
  const { store, container, render } = fixture();
  thinking(store);
  store.apply({
    type: "tool_execution_start",
    toolCallId: "unfinished",
    toolName: "read",
    args: { path: "README.md" },
  });
  render();
  store.apply({ type: "agent_settled" });
  render();
  expect(container.querySelector(".execution.is-running")).toBeNull();
  expect(container.querySelector(".execution-label")?.textContent).toBe(
    "Interrupted",
  );
  expect(
    container.querySelector<HTMLElement>(".execution-preview")?.hidden,
  ).toBe(true);
});

it("updates elapsed time without rerendering messages or changing scroll", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const { store, container, render } = fixture();
  const message = container.firstElementChild;
  container.scrollTop = 25;
  vi.advanceTimersByTime(65000);
  updateActivityElapsed(container);
  expect(container.querySelector(".execution-elapsed")?.textContent).toBe(
    "1 分 5 秒",
  );
  expect(container.firstElementChild).toBe(message);
  expect(container.scrollTop).toBe(25);
  store.apply({ type: "agent_settled" });
  render();
  expect(container.querySelector("[data-started-at]")).toBeNull();
});
