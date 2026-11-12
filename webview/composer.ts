import type {
  ClientAction,
  ContextFile,
  HostMessage,
} from "../src/shared/bridge";
import type { FormTextarea } from "./components";
import { formButton } from "./components";
import { builtinCommands } from "../src/shared/commands";

export function findMention(text: string, cursor: number) {
  const match = /(?:^|\s)@([^\n@]*)$/.exec(text.slice(0, cursor));
  if (!match) return;
  return { start: cursor - match[1].length - 1, end: cursor, query: match[1] };
}

export class PromptHistory {
  entries: string[];
  private index: number;
  private draft = "";
  constructor(entries: unknown = []) {
    this.entries = Array.isArray(entries)
      ? entries
          .filter(
            (x): x is string => typeof x === "string" && x.length <= 100000,
          )
          .slice(-50)
      : [];
    this.index = this.entries.length;
  }
  record(text: string) {
    if (text.trim() && text.length <= 100000 && this.entries.at(-1) !== text)
      this.entries = [...this.entries, text].slice(-50);
    this.reset();
  }
  reset() {
    this.index = this.entries.length;
  }
  get isBrowsing() {
    return this.index < this.entries.length;
  }
  previous(current: string) {
    if (this.index === this.entries.length) this.draft = current;
    this.index = Math.max(0, this.index - 1);
    return this.entries[this.index] ?? current;
  }
  next() {
    this.index = Math.min(this.entries.length, this.index + 1);
    return this.entries[this.index] ?? this.draft;
  }
}

export function setupComposer(
  prompt: FormTextarea,
  menu: HTMLElement,
  post: (action: ClientAction) => void,
  commands: () => readonly {
    name: string;
    description?: string;
    source: string;
  }[],
  save: () => void,
  history: PromptHistory,
) {
  let requestId = 0;
  let active = 0;
  let options: { label: string; choose(): void }[] = [];
  let mention: ReturnType<typeof findMention>;
  let lastQuery = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let searchingHistory = false;
  const pending = new Map<
    string,
    { value: string; start: number; end: number }
  >();
  // Web Awesome exposes textarea's public selection API; jsdom fixture uses its host value.
  const caret = () =>
    prompt.input?.selectionStart ?? (prompt.value ?? "").length;
  const close = () => {
    clearTimeout(timer);
    requestId++;
    menu.hidden = true;
    options = [];
    searchingHistory = false;
    prompt.removeAttribute("aria-activedescendant");
    prompt.setAttribute("aria-expanded", "false");
  };
  function draw(note?: string) {
    menu.replaceChildren();
    menu.hidden = false;
    prompt.setAttribute("aria-expanded", "true");
    for (const [index, option] of options.entries()) {
      const button = formButton(option.label, "command-option");
      button.id = `completion-${index}`;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === active));
      button.tabIndex = -1;
      button.onclick = () => {
        option.choose();
        close();
        prompt.focus();
      };
      menu.append(button);
    }
    if (options.length)
      prompt.setAttribute("aria-activedescendant", `completion-${active}`);
    menu.children[active]?.scrollIntoView?.({ block: "nearest" });
    if (note || !options.length) {
      const hint = document.createElement("div");
      hint.className = "muted completion-hint";
      hint.textContent = note ?? "没有匹配项";
      menu.append(hint);
    }
  }
  function refresh() {
    const text = prompt.value ?? "";
    if (searchingHistory) {
      options = history.entries
        .slice()
        .reverse()
        .filter((entry) => entry.toLowerCase().includes(text.toLowerCase()))
        .map((entry) => ({
          label: entry.slice(0, 160),
          choose() {
            prompt.value = entry;
            history.reset();
            save();
          },
        }));
      active = 0;
      draw("输入文字筛选历史 · Escape 退出");
      return;
    }
    mention = findMention(text, caret());
    const slash = /^\/([^\s]*)$/.exec(text);
    if (!mention && !slash) {
      close();
      lastQuery = "";
      return;
    }
    if (mention) {
      const query = mention.query;
      const queryKey = `@${mention.start}:${mention.end}:${query}`;
      if (!menu.hidden && lastQuery === queryKey) return;
      lastQuery = queryKey;
      clearTimeout(timer);
      const id = ++requestId;
      options = [];
      active = 0;
      draw("搜索文件… · @open: 已打开 · @current: 当前文件");
      timer = setTimeout(
        () => post({ type: "searchFiles", query, requestId: id }),
        120,
      );
    } else if (slash) {
      const selected = options[active]?.label;
      lastQuery = `/${slash[1]}`;
      const discovered = commands();
      options = [
        ...builtinCommands
          .filter((cmd) => !discovered.some((item) => item.name === cmd.name))
          .map((cmd) => ({ ...cmd, source: "插件快捷操作" })),
        ...discovered,
      ]
        .filter((cmd) =>
          cmd.name.toLowerCase().includes(slash[1].toLowerCase()),
        )
        .slice(0, 30)
        .map((cmd) => ({
          label: `/${cmd.name} · ${cmd.description ?? cmd.source}`,
          choose() {
            prompt.value = `/${cmd.name} `;
            history.reset();
            save();
          },
        }));
      active = Math.max(
        0,
        options.findIndex((option) => option.label === selected),
      );
      draw();
    }
  }
  return {
    get isAttaching() {
      return pending.size > 0;
    },
    refresh,
    close,
    receive(message: HostMessage) {
      if (message.type === "contextAttached") {
        const token = pending.get(message.id);
        pending.delete(message.id);
        if (token && message.success && prompt.value === token.value) {
          prompt.value =
            token.value.slice(0, token.start) + token.value.slice(token.end);
          close();
          lastQuery = "";
          void prompt.updateComplete?.then(() =>
            prompt.setSelectionRange?.(token.start, token.start),
          );
          history.reset();
          save();
        }
        return;
      }
      if (
        message.type !== "fileCandidates" ||
        message.requestId !== requestId ||
        !mention ||
        menu.hidden
      )
        return;
      const token = { ...mention };
      options = message.items.map((item: ContextFile) => ({
        label: `${item.label} · ${item.description ?? { current: "当前文件", open: "已打开", workspace: "工作区" }[item.source]}`,
        choose() {
          pending.set(item.id, {
            value: prompt.value ?? "",
            start: token.start,
            end: token.end,
          });
          post({ type: "attachContext", id: item.id });
        },
      }));
      active = 0;
      draw(
        message.error ??
          (message.truncated
            ? "插件仅列出部分结果，请输入更完整的路径。"
            : undefined),
      );
    },
    keydown(event: KeyboardEvent): boolean {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "r" &&
        !event.isComposing
      ) {
        searchingHistory = true;
        refresh();
        event.preventDefault();
        return true;
      }
      if (
        event.isComposing ||
        event.shiftKey ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey
      )
        return false;
      if (!menu.hidden) {
        if (
          ["Escape", "ArrowDown", "ArrowUp", "Tab", "Enter"].includes(event.key)
        ) {
          if (event.key === "Escape") close();
          else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (options.length)
              active =
                (active +
                  (event.key === "ArrowDown" ? 1 : options.length - 1)) %
                options.length;
            draw();
          } else if (options.length) {
            options[active].choose();
            close();
          }
          // Enter while loading/empty never sends an unresolved mention or command.
          event.preventDefault();
          return true;
        }
      }
      const text = prompt.value ?? "";
      const position = caret();
      if (
        event.key === "ArrowUp" &&
        (history.isBrowsing ||
          text === "" ||
          (position === 0 && !text.includes("\n")))
      ) {
        prompt.value = history.previous(text);
      } else if (event.key === "ArrowDown" && history.isBrowsing) {
        prompt.value = history.next();
      } else return false;
      event.preventDefault();
      const end = event.key === "ArrowDown" ? (prompt.value ?? "").length : 0;
      prompt.setSelectionRange?.(end, end);
      save();
      return true;
    },
  };
}
