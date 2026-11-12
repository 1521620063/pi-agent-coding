// @vitest-environment jsdom
import { expect, it } from "vitest";
import { renderTool } from "../../webview/chat";
it("renders unknown MCP results as bounded text and validated data images", () => {
  const node = renderTool({
    id: "mcp",
    name: "mcp_custom_tool",
    args: {},
    status: "error",
    result: {
      content: [
        { type: "text", text: "x".repeat(50000) },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ],
    },
  });
  expect(node.textContent?.length).toBeLessThan(31000);
  expect(node.textContent).toContain("插件限制");
  expect(node.querySelector("img")?.src).toMatch(/^data:image\/png/);
  expect(node.className).toContain("error");
});
it("does not invent an edit diff when no diff details exist", () => {
  const node = renderTool({
    id: "edit",
    name: "edit",
    args: { path: "a.ts" },
    status: "success",
    result: { content: [{ type: "text", text: "done" }] },
  });
  expect(node.querySelector(".diff")).toBeNull();
});
