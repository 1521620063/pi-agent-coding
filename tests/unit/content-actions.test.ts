// @vitest-environment jsdom
import { expect, it } from "vitest";
import { renderChat } from "../../webview/chat";
import { SessionStore } from "../../src/state/session-store";

it("offers copy, code editor and real fork actions with stable message indices", () => {
  const store = new SessionStore();
  store.replaceMessages([
    { role: "user", content: "question" },
    { role: "assistant", content: "answer\n```ts\nconst x = 1;\n```" },
  ]);
  const container = document.createElement("div");
  renderChat(container, store.getSnapshot());
  expect(
    container.querySelector<HTMLElement>("[data-message-index]")?.dataset
      .messageIndex,
  ).toBe("0");
  expect(
    container.querySelector<HTMLElement>("[data-code-text]")?.dataset.codeText,
  ).toBe("const x = 1;\n");
  expect(
    container.querySelector<HTMLElement>("[data-code-text]")?.dataset.language,
  ).toBe("ts");
  expect(
    [...container.querySelectorAll<HTMLElement>("[data-copy-text]")].some(
      (node) => node.dataset.copyText?.startsWith("answer"),
    ),
  ).toBe(true);
  renderChat(container, store.getSnapshot(), "missing");
  expect(container.querySelectorAll("article")).toHaveLength(0);
  expect(store.getSnapshot().messages).toHaveLength(2);
});

it("restores tool paths from authoritative messages for touched-file navigation", () => {
  const store = new SessionStore();
  store.replaceMessages([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "t",
          name: "edit",
          arguments: { path: "main.ts" },
        },
      ],
    },
    { role: "toolResult", toolCallId: "t", toolName: "edit", content: [] },
  ]);
  expect(store.getSnapshot().tools[0].args.path).toBe("main.ts");
});
