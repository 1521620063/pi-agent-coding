// @vitest-environment jsdom
import { expect, it } from "vitest";
import { renderChat, renderMarkdown, shouldSend } from "../../webview/chat";
import { SessionStore } from "../../src/state/session-store";
import { encodeAttachment } from "../../src/shared/attachment-message";

it("renders user attachment names and metadata without mounting file contents in the DOM", () => {
  const payload = encodeAttachment(
    {
      name: "src/中文.ts",
      kind: "text",
      size: 20,
      reference: "/workspace/src/中文.ts",
    },
    "PRIVATE FILE CONTENT",
  );
  for (const content of [
    `帮我分析\n\n${payload}`,
    [{ type: "text", text: `帮我分析\n\n${payload}` }],
  ]) {
    const store = new SessionStore();
    store.replaceMessages([{ role: "user", content }]);
    const node = document.createElement("div");
    renderChat(node, store.getSnapshot());
    expect(node.textContent).toContain("帮我分析");
    expect(node.textContent).toContain("src/中文.ts");
    expect(node.textContent).toContain("20 B");
    expect(node.innerHTML).not.toContain("PRIVATE FILE CONTENT");
    expect(node.innerHTML).not.toContain("pi-attachment");
    expect(
      node.querySelector<HTMLButtonElement>("[data-reference]")?.dataset
        .reference,
    ).toBe("/workspace/src/中文.ts");
    const reloaded = document.createElement("div");
    renderChat(reloaded, JSON.parse(JSON.stringify(store.getSnapshot())));
    expect(reloaded.innerHTML).not.toContain("PRIVATE FILE CONTENT");
  }
});

it("keeps assistant text intact and treats attachment names as text", () => {
  const payload = encodeAttachment(
    { name: '<img src=x onerror="alert(1)">', kind: "text", size: 4 },
    "code",
  );
  const store = new SessionStore();
  store.replaceMessages([
    { role: "user", content: payload },
    { role: "assistant", content: payload },
  ]);
  const node = document.createElement("div");
  renderChat(node, store.getSnapshot());
  expect(node.querySelector(".user-message img")).toBeNull();
  expect(node.querySelector(".user-message")?.textContent).toContain(
    '<img src=x onerror="alert(1)">',
  );
  expect(node.querySelector(".assistant-message")?.textContent).toContain(
    "code",
  );
});
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
it("routes file references through the host without enabling file or command URLs", () => {
  const node = document.createElement("div");
  node.innerHTML = renderMarkdown(
    "[source](src/main.ts#L12) [bad](file:///secret) [bad](command:evil)",
  );
  expect(
    node.querySelector("a[data-reference]")?.getAttribute("data-reference"),
  ).toBe("src/main.ts#L12");
  expect(node.querySelector("a[data-reference]")?.getAttribute("href")).toBe(
    "#",
  );
  expect(node.querySelector('[href^="file:"]')).toBeNull();
  expect(node.querySelector('[href^="command:"]')).toBeNull();
});
