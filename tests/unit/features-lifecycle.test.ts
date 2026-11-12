import { expect, it, vi } from "vitest";
import {
  ExtensionUiManager,
  type UiAnswer,
} from "../../src/features/extension-ui";
import { ShellService } from "../../src/features/shell";
import { SessionStore } from "../../src/state/session-store";

it("accepts a reused dialog ID after reconnect and ignores the old dialog result", async () => {
  const store = new SessionStore();
  const send = vi.fn(async () => {});
  const answers: Array<(answer: UiAnswer) => void> = [];
  const ui = new ExtensionUiManager(
    store,
    send,
    () => new Promise((resolve) => answers.push(resolve)),
  );
  const request = {
    type: "extension_ui_request" as const,
    method: "input",
    id: "dialog",
  };
  ui.handle(request);
  ui.dispose();
  ui.handle(request);
  expect(store.getSnapshot().pendingUi).toHaveLength(1);
  answers[0]({ value: "old connection" });
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
  expect(store.getSnapshot().pendingUi).toHaveLength(1);
  answers[1]({ value: "new connection" });
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send).toHaveBeenCalledWith({
    type: "extension_ui_response",
    id: "dialog",
    value: "new connection",
  });
  ui.dispose();
});

it("uses the final PI bash snapshot when streaming updates only contain part of the output", async () => {
  const store = new SessionStore();
  let update: (
    record: import("../../src/pi/protocol").PiRecord,
  ) => void = () => {};
  const pi = {
    onRecord: (listener: typeof update) => {
      update = listener;
      return () => {};
    },
    request: vi.fn(async (command: { id?: string }) => {
      update({
        type: "bash_execution_update",
        id: command.id,
        delta: "partial",
      });
      return { output: "partial\nfinal line", exitCode: 0 };
    }),
  };
  const shell = new ShellService(pi as never, store);
  await shell.execute("echo fixture", false);
  expect(store.getSnapshot().shell?.output).toBe("partial\nfinal line");
  shell.dispose();
});

it("keeps an authoritative empty bash result instead of stale streamed text", async () => {
  const store = new SessionStore();
  let update: (
    record: import("../../src/pi/protocol").PiRecord,
  ) => void = () => {};
  const pi = {
    onRecord: (listener: typeof update) => {
      update = listener;
      return () => {};
    },
    request: vi.fn(async (command: { id?: string }) => {
      update({
        type: "bash_execution_update",
        id: command.id,
        delta: "stale text",
      });
      return { output: "", exitCode: 0 };
    }),
  };
  const shell = new ShellService(pi as never, store);
  await shell.execute("echo fixture", false);
  expect(store.getSnapshot().shell?.output).toBe("");
  shell.dispose();
});
