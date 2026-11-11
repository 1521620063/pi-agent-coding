// @vitest-environment jsdom
import { expect, it } from "vitest";
import { renderMarkdown, shouldSend } from "../../webview/chat";
it("does not send Enter during IME composition or Shift+Enter", () => {
  expect(shouldSend({ key: "Enter", isComposing: true, shiftKey: false })).toBe(
    false,
  );
  expect(shouldSend({ key: "Enter", isComposing: false, shiftKey: true })).toBe(
    false,
  );
  expect(
    shouldSend({ key: "Enter", isComposing: false, shiftKey: false }),
  ).toBe(true);
});
it("renders code and strips executable HTML and command links", () => {
  const node = document.createElement("div");
  node.innerHTML = renderMarkdown(
    "<script>alert(1)</script>\n[bad](command:workbench.action.terminal.new)\n\n```js\nconsole.log(1)\n```",
  );
  expect(node.querySelector("script")).toBeNull();
  expect(node.querySelector('[href^="command:"]')).toBeNull();
  expect(node.querySelector("code")?.textContent).toContain("console.log");
});
