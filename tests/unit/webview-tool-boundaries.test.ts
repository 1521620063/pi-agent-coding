// @vitest-environment jsdom
import { expect, it } from "vitest";
import { renderTool } from "../../webview/chat";

it("labels a clipped edit diff as a plugin preview limit", () => {
  const node = renderTool({
    id: "edit",
    name: "edit",
    args: { path: "file.ts" },
    status: "success",
    result: { details: { diff: "x".repeat(30001) } },
  });
  expect(node.querySelector(".diff")?.textContent).toContain(
    "显示已截断（插件限制）",
  );
  expect(node.querySelector(".diff")?.textContent?.length).toBeLessThan(30100);
});

it("ignores malformed and unknown tool content while retaining supported output", () => {
  let node: HTMLElement | undefined;
  expect(() => {
    node = renderTool({
      id: "custom",
      name: "custom_mcp_tool",
      args: {},
      status: "success",
      result: {
        content: [
          null,
          42,
          { type: "future" },
          { type: "text", text: "visible output" },
        ],
      },
    });
  }).not.toThrow();
  expect(node?.textContent).toContain("visible output");
});

it("keeps a tool visible when its content is not an array", () => {
  expect(() =>
    renderTool({
      id: "custom",
      name: "custom_mcp_tool",
      args: {},
      status: "success",
      result: { content: { unexpected: true } },
    }),
  ).not.toThrow();
});
