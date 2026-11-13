// @vitest-environment jsdom
import { expect, it } from "vitest";
import { renderChat, renderTool } from "../../webview/chat";
import { SessionStore } from "../../src/state/session-store";

function fixture() {
  const state = new SessionStore().getSnapshot();
  state.connection = "connected";
  state.messages = [
    { role: "user", content: "检查这个项目" },
    { role: "assistant", content: "先阅读文件，再运行检查。" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "需要核对配置" },
        { type: "toolCall", id: "read", name: "read" },
      ],
    },
    { role: "toolResult", toolCallId: "read", content: "file content" },
    { role: "assistant", content: "接下来运行检查。" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "bash", name: "bash" }],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "整理检查结果" },
        { type: "text", text: "检查完成，这是最终结论。" },
      ],
    },
  ];
  state.tools = [
    {
      id: "read",
      name: "read",
      args: { path: "src/main.ts" },
      status: "success",
    },
    {
      id: "bash",
      name: "bash",
      args: { command: "npm run check && npm test" },
      status: "success",
      result: { content: [{ type: "text", text: "passed" }] },
    },
  ];
  const container = document.createElement("div");
  renderChat(container, state);
  return { state, container };
}

it("collapses commentary, thinking and multiple tool calls into one process while leaving the final answer visible", () => {
  const { container } = fixture();
  expect(container.children).toHaveLength(3);
  const execution = container.querySelector<HTMLDetailsElement>(".execution")!;
  expect(execution.open).toBe(false);
  expect(execution.querySelector("summary")?.getAttribute("aria-label")).toBe(
    "执行过程 · 2 项操作",
  );
  expect(execution.querySelectorAll(".tool")).toHaveLength(2);
  expect(execution.textContent).toContain("先阅读文件");
  expect(execution.textContent).toContain("接下来运行检查");
  expect(execution.textContent).not.toContain("最终结论");
  expect(
    container.lastElementChild?.querySelector(".markdown")?.textContent,
  ).toContain("最终结论");
});

it("keeps expanded groups, tools and their focus stable as more operations arrive", () => {
  const { state, container } = fixture();
  const execution = container.querySelector<HTMLDetailsElement>(".execution")!;
  const read = execution.querySelector<HTMLDetailsElement>(".tool")!;
  execution.open = true;
  read.open = true;
  const button = read.querySelector("button")!;
  document.body.append(container);
  button.focus();
  state.run = "running";
  state.messages.splice(6, 0, {
    role: "assistant",
    content: [{ type: "toolCall", id: "third", name: "custom_mcp" }],
  });
  state.tools.push({
    id: "third",
    name: "custom_mcp",
    args: {},
    status: "pending",
  });
  renderChat(container, structuredClone(state));
  expect(container.querySelector(".execution")).toBe(execution);
  expect(execution.open).toBe(true);
  expect(read.open).toBe(true);
  expect(document.activeElement).toBe(button);
  expect(
    execution.querySelector("summary")?.getAttribute("aria-label"),
  ).toContain("正在执行 · 3 项操作");
  expect(execution.querySelector(".execution-current")?.textContent).toBe(
    "custom_mcp",
  );
  expect(
    execution.querySelector<HTMLElement>(".execution-failure")?.hidden,
  ).toBe(true);
  expect(container.lastElementChild?.textContent).toContain("最终结论");
});

it("shows failure counts in collapsed groups and retains full arguments and output", () => {
  const { state, container } = fixture();
  state.tools[1].status = "error";
  state.tools[1].result = { content: [{ type: "text", text: "检查失败详情" }] };
  renderChat(container, structuredClone(state));
  const execution = container.querySelector<HTMLDetailsElement>(".execution")!;
  expect(execution.open).toBe(false);
  expect(execution.classList.contains("has-error")).toBe(true);
  expect(execution.querySelector("summary")?.textContent).toContain("1 项失败");
  expect(execution.querySelector(".tool.error .tool-action")?.textContent).toBe(
    "运行命令",
  );
  expect(
    execution.querySelector(".tool.error .tool-args")?.textContent,
  ).toContain("npm run check && npm test");
  expect(execution.querySelector(".tool.error .tool-output")?.textContent).toBe(
    "检查失败详情",
  );
});

it("separates turns and exposes matching commentary during search without losing expansion", () => {
  const { state, container } = fixture();
  const execution = container.querySelector<HTMLDetailsElement>(".execution")!;
  execution.open = true;
  renderChat(container, structuredClone(state), "接下来");
  expect(container.querySelector(".execution")).toBeNull();
  expect(container.querySelector(".markdown")?.textContent).toContain("接下来");
  renderChat(container, structuredClone(state));
  expect(container.querySelector(".execution")).toBe(execution);
  expect(execution.open).toBe(true);
  state.messages.push(
    { role: "user", content: "再看另一个文件" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "next", name: "read" }],
    },
  );
  state.tools.push({
    id: "next",
    name: "read",
    args: { path: "README.md" },
    status: "pending",
  });
  renderChat(container, structuredClone(state));
  expect(container.querySelectorAll(".execution")).toHaveLength(2);
  expect(
    container.querySelectorAll<HTMLDetailsElement>(".execution")[1].open,
  ).toBe(false);
});

it.each(["constructor", "__proto__"])(
  "displays an unknown tool named %s literally",
  (name) => {
    const tool = renderTool({ id: name, name, args: {}, status: "success" });
    expect(tool.querySelector(".tool-action")?.textContent).toBe(name);
  },
);

it("retains a standalone process when its tool call arrives later", () => {
  const state = new SessionStore().getSnapshot();
  state.connection = "connected";
  state.messages = [{ role: "user", content: "检查文件" }];
  state.tools = [
    {
      id: "early",
      name: "read",
      args: { path: "README.md" },
      status: "pending",
    },
  ];
  const container = document.createElement("div");
  renderChat(container, state);
  const execution = container.querySelector<HTMLDetailsElement>(".execution")!;
  const tool = execution.querySelector<HTMLDetailsElement>(".tool")!;
  execution.open = true;
  tool.open = true;
  state.messages.push({ role: "assistant", content: "先读取文件。" });
  renderChat(container, structuredClone(state));
  expect(container.querySelector(".execution")).toBe(execution);
  state.messages.push({
    role: "assistant",
    content: [{ type: "toolCall", id: "early" }],
  });
  renderChat(container, structuredClone(state));
  expect(container.querySelector(".execution")).toBe(execution);
  expect(execution.open).toBe(true);
  expect(tool.open).toBe(true);
  expect(container.querySelectorAll(".tool")).toHaveLength(1);
});

it("groups thinking-only updates without hiding normal answers and marks interrupted tools", () => {
  const { state, container } = fixture();
  state.messages = [
    { role: "user", content: "你好" },
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "组织回答" }],
    },
    { role: "assistant", content: "你好，有什么需要帮忙的？" },
  ];
  state.tools = [];
  renderChat(container, structuredClone(state));
  expect(container.children).toHaveLength(3);
  expect(container.querySelector(".execution")?.textContent).toContain(
    "组织回答",
  );
  expect(container.lastElementChild?.textContent).toContain("有什么需要帮忙");
  state.tools.push({
    id: "orphan",
    name: "bash",
    args: { command: "npm test" },
    status: "pending",
  });
  state.connection = "disconnected";
  renderChat(container, structuredClone(state));
  expect(
    container.querySelector(".execution > summary")?.textContent,
  ).toContain("执行已中断");
});
