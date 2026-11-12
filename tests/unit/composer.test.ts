// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
vi.mock("../../webview/register-components", () => ({}));
import {
  findMention,
  PromptHistory,
  setupComposer,
} from "../../webview/composer";
import type { FormTextarea } from "../../webview/components";

it("finds the active mention at the caret, preserving text after it", () => {
  expect(findMention("请看 @src/中文.ts 后续文字", 13)).toEqual({
    start: 3,
    end: 13,
    query: "src/中文.ts",
  });
  expect(findMention("email@example.com", 17)).toBeUndefined();
  expect(findMention("```\nhello", 9)).toBeUndefined();
  expect(findMention("@open:", 6)?.query).toBe("open:");
});

it("discards stale file searches and preserves text until attachment succeeds", async () => {
  vi.useFakeTimers();
  const prompt = Object.assign(document.createElement("wa-textarea"), {
    value: "@old",
  }) as FormTextarea;
  const menu = document.createElement("div");
  menu.hidden = true;
  const post = vi.fn();
  const composer = setupComposer(
    prompt,
    menu,
    post,
    () => [],
    () => {},
    new PromptHistory(),
  );
  composer.refresh();
  await vi.advanceTimersByTimeAsync(120);
  const oldId = post.mock.calls.at(-1)![0].requestId;
  prompt.value = "@new";
  composer.refresh();
  await vi.advanceTimersByTimeAsync(120);
  const newId = post.mock.calls.at(-1)![0].requestId;
  composer.receive({
    type: "fileCandidates",
    requestId: oldId,
    items: [{ id: "old", label: "old", source: "workspace" }],
    truncated: false,
  });
  expect(menu.textContent).not.toContain("old ·");
  composer.receive({
    type: "fileCandidates",
    requestId: newId,
    items: [{ id: "new", label: "new", source: "workspace" }],
    truncated: false,
  });
  const enter = new KeyboardEvent("keydown", {
    key: "Enter",
    cancelable: true,
  });
  expect(composer.keydown(enter)).toBe(true);
  expect(post).toHaveBeenLastCalledWith({ type: "attachContext", id: "new" });
  expect(prompt.value).toBe("@new");
  composer.receive({ type: "contextAttached", id: "new", success: false });
  expect(prompt.value).toBe("@new");
  composer.refresh();
  await vi.advanceTimersByTimeAsync(120);
  composer.receive({
    type: "fileCandidates",
    requestId: post.mock.calls.at(-1)![0].requestId,
    items: [{ id: "ok", label: "new", source: "workspace" }],
    truncated: false,
  });
  composer.keydown(new KeyboardEvent("keydown", { key: "Enter" }));
  prompt.value = "newer draft";
  composer.receive({ type: "contextAttached", id: "ok", success: true });
  expect(prompt.value).toBe("newer draft");
  vi.useRealTimers();
});

it("navigates slash completion without sending, and ignores IME Enter", () => {
  const prompt = Object.assign(document.createElement("wa-textarea"), {
    value: "/",
  }) as FormTextarea;
  const menu = document.createElement("div");
  menu.hidden = true;
  const post = vi.fn();
  const composer = setupComposer(
    prompt,
    menu,
    post,
    () => [
      { name: "one", source: "skill" },
      { name: "two", source: "prompt" },
    ],
    () => {},
    new PromptHistory(),
  );
  composer.refresh();
  expect(
    composer.keydown(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true }),
    ),
  ).toBe(false);
  composer.keydown(new KeyboardEvent("keydown", { key: "ArrowDown" }));
  composer.refresh(); // Streaming snapshots must not reset the highlighted command.
  composer.keydown(new KeyboardEvent("keydown", { key: "Tab" }));
  expect(prompt.value).toBe("/compact ");
  expect(post).not.toHaveBeenCalled();
});

it("offers built-in session commands without PI-discovered commands", () => {
  const prompt = Object.assign(document.createElement("wa-textarea"), {
    value: "/",
  }) as FormTextarea;
  const menu = document.createElement("div");
  const post = vi.fn();
  const composer = setupComposer(
    prompt,
    menu,
    post,
    () => [],
    () => {},
    new PromptHistory(),
  );
  composer.refresh();
  expect(menu.textContent).toContain("/new");
  expect(menu.textContent).toContain("/compact");
  prompt.value = "/comp";
  composer.refresh();
  composer.keydown(new KeyboardEvent("keydown", { key: "Tab" }));
  expect(prompt.value).toBe("/compact ");
  expect(post).not.toHaveBeenCalled();
});

it("prioritizes shortcuts while preserving PI commands with colliding names", () => {
  const prompt = Object.assign(document.createElement("wa-textarea"), {
    value: "/",
  }) as FormTextarea;
  const menu = document.createElement("div");
  const composer = setupComposer(
    prompt,
    menu,
    () => {},
    () => [
      { name: "model", source: "prompt", description: "自定义模板" },
      ...Array.from({ length: 40 }, (_, n) => ({
        name: `custom-${n}`,
        source: "extension",
      })),
    ],
    () => {},
    new PromptHistory(),
  );
  composer.refresh();
  expect(menu.firstElementChild?.textContent).toContain("/new");
  prompt.value = "/model";
  composer.refresh();
  expect(menu.textContent).toContain("自定义模板");
  expect(menu.querySelectorAll("[role=option]")).toHaveLength(1);
});

it("restores a draft with Down after recalling a multiline history entry", () => {
  const input = document.createElement("textarea");
  const prompt = Object.assign(document.createElement("wa-textarea"), {
    value: "draft",
    input,
  }) as unknown as FormTextarea;
  const menu = document.createElement("div");
  menu.hidden = true;
  const history = new PromptHistory(["line one\nline two"]);
  const composer = setupComposer(
    prompt,
    menu,
    () => {},
    () => [],
    () => {},
    history,
  );
  input.setSelectionRange(0, 0);
  expect(
    composer.keydown(new KeyboardEvent("keydown", { key: "ArrowUp" })),
  ).toBe(true);
  expect(prompt.value).toBe("line one\nline two");
  expect(
    composer.keydown(new KeyboardEvent("keydown", { key: "ArrowDown" })),
  ).toBe(true);
  expect(prompt.value).toBe("draft");
});

it("keeps bounded input history and restores the draft after browsing", () => {
  const history = new PromptHistory(["old", "one"]);
  history.record("two");
  history.record("two");
  expect(history.previous("draft")).toBe("two");
  expect(history.previous("two")).toBe("one");
  expect(history.next()).toBe("two");
  expect(history.next()).toBe("draft");
  for (let n = 0; n < 100; n++) history.record(String(n));
  expect(history.entries).toHaveLength(50);
  expect(history.entries.at(-1)).toBe("99");
});

it.each([{ entries: [] }, { entries: ["older prompt"] }])(
  "preserves a fresh draft on Down before browsing history ($entries)",
  ({ entries }) => {
    const prompt = Object.assign(document.createElement("wa-textarea"), {
      value: "新的草稿",
    }) as FormTextarea;
    const menu = document.createElement("div");
    menu.hidden = true;
    const save = vi.fn();
    const composer = setupComposer(
      prompt,
      menu,
      () => {},
      () => [],
      save,
      new PromptHistory(entries),
    );
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      cancelable: true,
    });
    expect(composer.keydown(event)).toBe(false);
    expect(prompt.value).toBe("新的草稿");
    expect(event.defaultPrevented).toBe(false);
    expect(save).not.toHaveBeenCalled();
  },
);
