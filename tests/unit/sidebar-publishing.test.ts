import { afterEach, expect, it, vi } from "vitest";
import { SessionStore } from "../../src/state/session-store";

vi.mock("vscode", () => ({
  Uri: { joinPath: (_base: unknown, path: string) => path },
}));
import { createSidebarProvider } from "../../src/sidebar/provider";

afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  const store = new SessionStore();
  const postMessage = vi.fn().mockResolvedValue(true);
  let receive!: (value: unknown) => Promise<void>;
  let visibility!: () => void;
  let dispose!: () => void;
  const view = {
    visible: true,
    webview: {
      postMessage,
      asWebviewUri: (value: unknown) => String(value),
      cspSource: "fixture",
      html: "",
      options: {},
      onDidReceiveMessage: (handler: typeof receive) => {
        receive = handler;
        return { dispose() {} };
      },
    },
    onDidChangeVisibility: (handler: typeof visibility) => {
      visibility = handler;
      return { dispose() {} };
    },
    onDidDispose: (handler: typeof dispose) => {
      dispose = handler;
      return { dispose() {} };
    },
  };
  const provider = createSidebarProvider(store, async () => {}, {} as never);
  provider.resolveWebviewView(view as never, {} as never, {} as never);
  return {
    store,
    provider,
    view,
    postMessage,
    receive: (value: unknown) => receive(value),
    visibility: () => visibility(),
    dispose: () => dispose(),
  };
}

it("coalesces streaming snapshots and sends the latest derived state once", async () => {
  const f = fixture();
  await f.receive({ type: "ready" });
  f.postMessage.mockClear();
  const snapshot = vi.spyOn(f.store, "getSnapshot");
  for (let i = 0; i < 100; i++)
    f.store.apply({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "x",
      },
    });
  f.store.update({
    queueControl: { revision: 4, busy: false, canSteer: true },
  });
  expect(f.postMessage).not.toHaveBeenCalled();
  expect(snapshot).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(16);
  expect(f.postMessage).toHaveBeenCalledOnce();
  expect(snapshot).toHaveBeenCalledOnce();
  expect(f.postMessage.mock.calls[0][0].state).toMatchObject({
    messages: [{ content: [{ text: "x".repeat(100) }] }],
    queueControl: { revision: 4 },
  });
  f.provider.dispose();
});

it("does not publish while hidden and restores the latest snapshot when shown", async () => {
  const f = fixture();
  f.view.visible = false;
  f.visibility();
  const snapshot = vi.spyOn(f.store, "getSnapshot");
  f.store.update({ title: "hidden" });
  await vi.advanceTimersByTimeAsync(32);
  expect(snapshot).not.toHaveBeenCalled();
  expect(f.postMessage).not.toHaveBeenCalled();
  f.view.visible = true;
  f.visibility();
  expect(f.postMessage).toHaveBeenCalledOnce();
  expect(f.postMessage.mock.calls[0][0].state.title).toBe("hidden");
  f.provider.dispose();
});

it.each([
  { firstAppend: false, expected: "first\n\nsecond" },
  { firstAppend: true, expected: "draft\n\nfirst\n\nsecond" },
])(
  "delivers consecutive editor revisions in order (append=$firstAppend)",
  async ({ firstAppend, expected }) => {
    const f = fixture();
    let draft = "draft";
    f.store.update({
      editorText: { text: "first", append: firstAppend, revision: 1 },
    });
    f.store.update({
      editorText: { text: "second", append: true, revision: 2 },
    });
    const edits = f.postMessage.mock.calls.map(
      ([message]) => message.state.editorText,
    );
    expect(edits.map((edit) => edit.revision)).toEqual([1, 2]);
    for (const edit of edits)
      draft = edit.append
        ? [draft, edit.text].filter(Boolean).join("\n\n")
        : edit.text;
    expect(draft).toBe(expected);
    await vi.advanceTimersByTimeAsync(16);
    expect(f.postMessage).toHaveBeenCalledTimes(2);
    f.provider.dispose();
  },
);

it("keeps editor instructions immediate while a resolved view is hidden", () => {
  const f = fixture();
  f.view.visible = false;
  f.visibility();
  f.store.update({ editorText: { text: "first", revision: 1 } });
  f.store.update({ editorText: { text: "second", append: true, revision: 2 } });
  expect(
    f.postMessage.mock.calls.map(
      ([message]) => message.state.editorText.revision,
    ),
  ).toEqual([1, 2]);
  expect(vi.getTimerCount()).toBe(0);
  f.provider.dispose();
});

it("flushes pending state before action acknowledgements to preserve draft and attachment ordering", () => {
  const f = fixture();
  f.store.update({
    editorText: { text: "restored", revision: 2 },
  });
  f.postMessage.mockClear();
  f.store.update({ attachments: [] });
  f.provider.post({ type: "sent", attachmentIds: [] });
  expect(f.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
    "snapshot",
    "sent",
  ]);
  expect(vi.getTimerCount()).toBe(0);
  f.provider.dispose();
});

it("cancels scheduled snapshots on ready, hiding, view disposal and provider disposal", async () => {
  const f = fixture();
  f.store.update({ title: "ready" });
  await f.receive({ type: "ready" });
  await vi.advanceTimersByTimeAsync(32);
  expect(f.postMessage).toHaveBeenCalledOnce();
  f.store.update({ title: "hidden" });
  f.view.visible = false;
  f.visibility();
  await vi.advanceTimersByTimeAsync(32);
  expect(f.postMessage).toHaveBeenCalledOnce();
  f.view.visible = true;
  f.visibility();
  f.postMessage.mockClear();
  f.store.update({ title: "disposed" });
  f.dispose();
  await vi.advanceTimersByTimeAsync(32);
  expect(f.postMessage).not.toHaveBeenCalled();
  f.provider.dispose();
  f.store.update({ title: "after disposal" });
  expect(vi.getTimerCount()).toBe(0);
});
