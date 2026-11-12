// @vitest-environment jsdom
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { SessionStore } from "../../src/state/session-store";
import type { ViewState } from "../../src/shared/bridge";

// jsdom lacks form-associated ElementInternals. Actual components are checked
// in the browser; these tests exercise the application's host-message wiring.
vi.mock("../../webview/register-components", () => ({}));

const postMessage = vi.fn();
const setState = vi.fn();
const control = (id: string) => document.getElementById(id)!;
const snapshot = (state: ViewState) =>
  window.dispatchEvent(
    new MessageEvent("message", { data: { type: "snapshot", state } }),
  );
const sent = () =>
  window.dispatchEvent(new MessageEvent("message", { data: { type: "sent" } }));
const value = (id: string, text: string) =>
  Object.assign(control(id), { value: text });

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal("acquireVsCodeApi", () => ({
    postMessage,
    setState,
    getState: () => ({ draft: "保留的草稿" }),
  }));
  await import("../../webview/main");
});
beforeEach(() => {
  sent();
  const state = new SessionStore().getSnapshot();
  state.connection = "connected";
  snapshot(state);
  postMessage.mockClear();
  setState.mockClear();
});

it("routes a Web Awesome menu selection once without forwarding unrelated values", () => {
  const menu = control("actions");
  const item = document.createElement("wa-dropdown-item");
  item.setAttribute("value", "settings");
  menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item } }));
  expect(postMessage.mock.calls).toEqual([[{ type: "settings" }]]);
  item.setAttribute("value", "send");
  menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item } }));
  expect(postMessage).toHaveBeenCalledTimes(1);
});

it("selects model and thinking levels next to their controls using the menu item in event.detail", () => {
  const state = new SessionStore().getSnapshot();
  state.connection = "connected";
  state.models = [
    { id: "m1", name: "模型一", provider: "test", input: ["text"] },
  ];
  state.thinkingLevels = ["low", "high"];
  state.model = state.models[0];
  state.thinkingLevel = "low";
  snapshot(state);
  const model = control("model-menu").querySelector("wa-dropdown-item")!;
  Object.assign(model, { checked: false });
  Object.assign(control("model-menu"), { open: true });
  const thinking =
    control("thinking-menu").querySelectorAll("wa-dropdown-item")[1];
  control("model-menu").dispatchEvent(
    new CustomEvent("wa-select", { detail: { item: model } }),
  );
  control("thinking-menu").dispatchEvent(
    new CustomEvent("wa-select", { detail: { item: thinking } }),
  );
  expect(postMessage.mock.calls).toEqual([
    [{ type: "chooseModel", provider: "test", modelId: "m1" }],
    [{ type: "chooseThinking", level: "high" }],
  ]);
  expect((model as HTMLElement & { checked: boolean }).checked).toBe(true);
  expect((control("model-menu") as HTMLElement & { open: boolean }).open).toBe(
    false,
  );
});

it("opens history beside its button, removes a row without selecting it, and closes with Escape", () => {
  const state = new SessionStore().getSnapshot();
  state.connection = "connected";
  state.sessions = [
    {
      sessionId: "s1",
      sessionPath: "one.jsonl",
      name: "会话一",
      lastOpenedAt: "2026-11-11",
    },
  ];
  snapshot(state);
  control("sessions").click();
  expect(control("history-panel").hidden).toBe(false);
  expect(control("sessions").getAttribute("aria-expanded")).toBe("true");
  control("history-panel")
    .querySelector<HTMLElement>("[data-remove-session]")!
    .click();
  expect(postMessage.mock.calls).toEqual([
    [{ type: "sessions" }],
    [{ type: "removeSession", sessionPath: "one.jsonl" }],
  ]);
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  expect(control("history-panel").hidden).toBe(true);
  expect(control("sessions").getAttribute("aria-expanded")).toBe("false");
});

it("selects history locally without altering the draft", () => {
  const state = new SessionStore().getSnapshot();
  state.connection = "connected";
  state.sessions = [
    { sessionId: "s1", sessionPath: "one.jsonl", lastOpenedAt: "2026-11-11" },
  ];
  value("prompt", "保留草稿");
  snapshot(state);
  control("sessions").click();
  control("history-panel")
    .querySelector<HTMLElement>("[data-select-session]")!
    .click();
  expect(postMessage).toHaveBeenLastCalledWith({
    type: "selectSession",
    sessionPath: "one.jsonl",
  });
  expect(control("history-panel").hidden).toBe(true);
  expect((control("prompt") as HTMLTextAreaElement).value).toBe("保留草稿");
});

it("preserves IME composition and Shift+Enter, then sends a follow-up once", () => {
  const prompt = value("prompt", "中文草稿");
  prompt.dispatchEvent(new CompositionEvent("compositionstart"));
  prompt.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
  control("send").click();
  expect(postMessage).not.toHaveBeenCalled();
  prompt.dispatchEvent(new CompositionEvent("compositionend"));
  prompt.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(postMessage).not.toHaveBeenCalled();
  prompt.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
  control("send").click();
  expect(postMessage.mock.calls).toEqual([
    [{ type: "send", text: "中文草稿", attachmentIds: [], mode: "followUp" }],
  ]);
});

it("keeps newer typing when the previous send is acknowledged", () => {
  const prompt = value("prompt", "已提交");
  control("send").click();
  value("prompt", "尚未提交的新内容");
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
  sent();
  expect((prompt as HTMLTextAreaElement).value).toBe("尚未提交的新内容");
  expect(setState).toHaveBeenLastCalledWith(
    expect.objectContaining({
      draft: "尚未提交的新内容",
      editorRevision: 0,
    }),
  );
});

it("routes switch values and shell form values through existing actions", () => {
  Object.assign(control("auto-compaction"), { checked: true }).dispatchEvent(
    new Event("change"),
  );
  Object.assign(control("auto-retry"), { checked: false }).dispatchEvent(
    new Event("change"),
  );
  value("shell-command", "echo PI").dispatchEvent(new Event("input"));
  Object.assign(control("shell-exclude"), { checked: true });
  control("run-shell").click();
  expect(postMessage.mock.calls).toEqual([
    [{ type: "autoCompaction", enabled: true }],
    [{ type: "autoRetry", enabled: false }],
    [{ type: "shell", command: "echo PI", excludeFromContext: true }],
  ]);
});

it("filters indexed sessions and routes queue modes without altering the prompt", () => {
  const state = new SessionStore().getSnapshot();
  state.connection = "connected";
  state.sessions = [
    { sessionId: "one", sessionPath: "one.jsonl", lastOpenedAt: "2026-11-12" },
    { sessionId: "two", sessionPath: "two.jsonl", lastOpenedAt: "2026-11-12" },
  ];
  snapshot(state);
  value("history-search", "two").dispatchEvent(new Event("input"));
  expect(
    control("history-list").querySelectorAll("[data-select-session]"),
  ).toHaveLength(1);
  expect(control("history-list").textContent).toContain("two");
  value("steering-mode", "all").dispatchEvent(new Event("change"));
  expect(postMessage).toHaveBeenLastCalledWith({
    type: "queueMode",
    channel: "steering",
    mode: "all",
  });
});

it("disables empty shell execution and exposes cancellation only while PI shell is active", () => {
  const run = control("run-shell") as HTMLButtonElement;
  const cancel = document.querySelector<HTMLElement>(
    '[data-action="cancelShell"]',
  )!;
  const state = new SessionStore().getSnapshot();
  state.connection = "connected";
  value("shell-command", "   ").dispatchEvent(new Event("input"));
  snapshot(state);
  expect(run.disabled).toBe(true);
  expect(cancel.hidden).toBe(true);
  value("shell-command", "echo PI").dispatchEvent(new Event("input"));
  expect(run.disabled).toBe(false);
  state.shell = { active: true, output: "running" };
  snapshot(state);
  expect(run.disabled).toBe(true);
  expect(cancel.hidden).toBe(false);
});
