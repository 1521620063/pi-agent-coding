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

it("allows sending again after disconnecting during an unacknowledged send", () => {
  value("prompt", "保留待确认消息");
  control("send").click();
  expect(postMessage.mock.calls.at(-1)?.[0].type).toBe("send");
  const state = new SessionStore().getSnapshot();
  snapshot(state);
  state.connection = "connected";
  snapshot(state);
  expect((control("prompt") as HTMLElement & { value: string }).value).toBe(
    "保留待确认消息",
  );
  expect(
    (control("send") as HTMLElement & { disabled: boolean }).disabled,
  ).toBe(false);
  control("send").click();
  expect(
    postMessage.mock.calls.filter(([action]) => action.type === "send"),
  ).toHaveLength(2);
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

it("preserves a cancelled command draft and releases submission state", () => {
  value("prompt", "/fork");
  control("send").click();
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "sent", attachmentIds: [], preserveDraft: true },
    }),
  );
  expect((control("prompt") as HTMLTextAreaElement).value).toBe("/fork");
  expect((control("send") as HTMLButtonElement).disabled).toBe(false);
});

it("opens existing sidebar controls from slash commands", () => {
  for (const [name, id] of [
    ["history", "history-panel"],
    ["settings", "settings-panel"],
  ]) {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "showControl", control: name },
      }),
    );
    expect(control(id).hidden).toBe(false);
  }
  control("settings-close").click();
});

it("sends /stop while another submission and queue promotion are pending", () => {
  const prompt = value("prompt", "/compact 保留重点");
  control("send").click();
  const state = new SessionStore().getSnapshot();
  state.connection = "connected";
  state.queueControl = { revision: 3, busy: true, canSteer: false };
  state.attachments = [
    { id: "file", kind: "text", name: "file.ts", size: 1, preview: "x" },
  ];
  snapshot(state);
  value("prompt", "/stop").dispatchEvent(new Event("input"));
  prompt.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
  // First Enter completes the selected slash option; the second executes it.
  prompt.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(postMessage).toHaveBeenLastCalledWith({
    type: "send",
    text: "/stop ",
    attachmentIds: [],
    mode: "followUp",
  });
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "commandCompleted", text: "/stop " },
    }),
  );
  expect((prompt as HTMLTextAreaElement).value).toBe("");
  value("prompt", "新的草稿");
  sent();
  expect((prompt as HTMLTextAreaElement).value).toBe("新的草稿");
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

it("opens manual compaction from usage and blocks it while busy or disconnected", () => {
  const state = new SessionStore().getSnapshot();
  state.connection = "connected";
  snapshot(state);
  const usage = control("usage") as HTMLButtonElement;
  expect(usage.tagName).toBe("BUTTON");
  usage.click();
  expect(postMessage.mock.calls).toEqual([[{ type: "compact" }]]);
  state.compaction = { active: true };
  snapshot(state);
  expect(usage.disabled).toBe(true);
  usage.click();
  expect(postMessage).toHaveBeenCalledTimes(1);
  expect(usage.textContent).toContain("正在压缩");
  expect(usage.getAttribute("aria-busy")).toBe("true");
  state.compaction = { active: false, error: "session too small" };
  snapshot(state);
  expect(usage.disabled).toBe(false);
  expect(control("activity").textContent).toContain("session too small");
  state.run = "running";
  snapshot(state);
  expect(usage.disabled).toBe(true);
  state.run = "idle";
  state.connection = "disconnected";
  snapshot(state);
  expect(usage.disabled).toBe(true);
});

it("shows a nothing-to-compact notice once without error styling and leaves chat usable", () => {
  const state = new SessionStore().getSnapshot();
  state.connection = "connected";
  state.compaction = {
    active: false,
    notice: "当前会话内容较少，PI 暂无可压缩的上下文，可继续对话。",
  };
  snapshot(state);
  expect(control("activity").textContent).toContain("暂无可压缩");
  expect(control("activity").querySelector(".error")).toBeNull();
  expect(control("error").hidden).toBe(true);
  expect((control("usage") as HTMLButtonElement).disabled).toBe(false);
  value("prompt", "继续对话");
  control("send").click();
  expect(postMessage).toHaveBeenLastCalledWith({
    type: "send",
    text: "继续对话",
    attachmentIds: [],
    mode: "followUp",
  });
});

it("explains a missing Bash command without treating its exit code as a PI disconnect", () => {
  const state = new SessionStore().getSnapshot();
  state.connection = "connected";
  value("shell-command", "你好");
  state.shell = {
    active: false,
    output: "/usr/bin/bash: line 1: 你好: command not found",
    exitCode: 127,
  };
  snapshot(state);
  expect(control("shell-output").textContent).toContain("命令退出码：127");
  expect(control("shell-output").textContent).toContain("未找到 Bash 命令");
  expect(control("shell-output").textContent).toContain("上方聊天输入框");
  expect(control("connection").hidden).toBe(true);
  expect((control("run-shell") as HTMLButtonElement).disabled).toBe(false);
  value("prompt", "你好");
  control("send").click();
  expect(postMessage).toHaveBeenLastCalledWith({
    type: "send",
    text: "你好",
    attachmentIds: [],
    mode: "followUp",
  });
  state.shell = { active: false, output: "PI", exitCode: 0 };
  snapshot(state);
  expect(control("shell-output").textContent).toBe("PI\n命令退出码：0");
});
