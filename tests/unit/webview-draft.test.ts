// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { SessionStore } from "../../src/state/session-store";
vi.mock("../../webview/register-components", () => ({}));
it("restores an unsent draft without replaying an already applied PI editor request", async () => {
  document.body.innerHTML = '<div id="app"></div>';
  (globalThis as any).acquireVsCodeApi = () => ({
    postMessage: vi.fn(),
    getState: () => ({ draft: "unsent newer text", editorRevision: 7 }),
    setState: vi.fn(),
  });
  await import("../../webview/main");
  const state = new SessionStore().getSnapshot();
  state.editorText = { text: "old PI editor value", revision: 7 };
  window.dispatchEvent(
    new MessageEvent("message", { data: { type: "snapshot", state } }),
  );
  expect((document.getElementById("prompt") as HTMLTextAreaElement).value).toBe(
    "unsent newer text",
  );
});
