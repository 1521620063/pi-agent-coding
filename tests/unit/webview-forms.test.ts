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

it("preserves IME composition and Shift+Enter, then sends the selected queue mode once", () => {
  const prompt = value("prompt", "中文草稿");
  value("mode", "steer");
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
    [{ type: "send", text: "中文草稿", attachmentIds: [], mode: "steer" }],
  ]);
});

it("keeps newer typing when the previous send is acknowledged", () => {
  const prompt = value("prompt", "已提交");
  control("send").click();
  value("prompt", "尚未提交的新内容");
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
  sent();
  expect((prompt as HTMLTextAreaElement).value).toBe("尚未提交的新内容");
  expect(setState).toHaveBeenLastCalledWith({
    draft: "尚未提交的新内容",
    editorRevision: 0,
  });
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
