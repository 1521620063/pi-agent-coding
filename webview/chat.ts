import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import {
  isObject,
  type AgentMessage,
  type JsonObject,
} from "../src/pi/protocol";
import type { ToolView, ViewState } from "../src/shared/bridge";
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const original = md.validateLink.bind(md);
const localReference = (url: string) =>
  !!url &&
  !/[\u0000-\u001f]/.test(url) &&
  !/^(?:command|javascript|data|file|https?|vscode):/i.test(url) &&
  (!/^(?![A-Za-z]:[\\/])[A-Za-z][\w+.-]*:/.test(url) ||
    /^[^:/\\]+:\d+(?::\d+)?$/.test(url)) &&
  !url.startsWith("//") &&
  !url.startsWith("#");
md.validateLink = (url) =>
  (/^https?:/i.test(url) && original(url)) || localReference(url);
const defaultLink =
  md.renderer.rules.link_open ??
  ((tokens, index, options, _env, self) =>
    self.renderToken(tokens, index, options));
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const href = String(tokens[index].attrGet("href") ?? "");
  if (!/^https?:/i.test(href) && localReference(href)) {
    let reference = href;
    try {
      reference = decodeURI(href);
    } catch {
      /* preserve invalid escape for host validation */
    }
    tokens[index].attrSet("data-reference", reference);
    tokens[index].attrSet("href", "#");
  }
  return defaultLink(tokens, index, options, env, self);
};
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(md.render(text), {
    ALLOWED_URI_REGEXP: /^(?:https?:\/\/|#$)/i,
    FORBID_TAGS: ["style", "script", "iframe", "form", "input"],
    FORBID_ATTR: ["style"],
  });
}
export function shouldSend(event: {
  key: string;
  isComposing: boolean;
  shiftKey: boolean;
}): boolean {
  return event.key === "Enter" && !event.isComposing && !event.shiftKey;
}
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
interface CachedNode {
  signature: string;
  node: HTMLElement;
}
interface ChatCache {
  context: string;
  messages: Map<number, CachedNode>;
  tools: Map<string, CachedNode>;
  empty?: HTMLElement;
  noMatches?: HTMLElement;
}
const chats = new WeakMap<HTMLElement, ChatCache>();

// Moving every child through a fragment would detach historical selection and
// focus even when its contents are unchanged. Touch only out-of-order children.
function reconcileChildren(parent: HTMLElement, children: HTMLElement[]) {
  let cursor = parent.firstChild;
  for (const child of children) {
    if (child === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(child, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
}

export function renderChat(
  container: HTMLElement,
  state: ViewState,
  query = "",
) {
  const nearBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight < 70;
  const context = JSON.stringify([
    state.workspace,
    state.session?.id,
    state.session?.path,
  ]);
  let cache = chats.get(container);
  if (!cache || cache.context !== context) {
    cache = { context, messages: new Map(), tools: new Map() };
    chats.set(container, cache);
  }
  const tools = new Map<string, HTMLElement>();
  for (const tool of state.tools) {
    const signature = JSON.stringify(tool);
    let cached = cache.tools.get(tool.id);
    if (!cached) {
      cached = { signature, node: renderTool(tool) };
      cache.tools.set(tool.id, cached);
    } else if (cached.signature !== signature) {
      const updated = renderTool(tool);
      cached.node.className = updated.className;
      cached.node.replaceChildren(...updated.childNodes);
      cached.signature = signature;
    }
    tools.set(tool.id, cached.node);
  }
  for (const id of cache.tools.keys())
    if (!tools.has(id)) cache.tools.delete(id);
  for (const index of cache.messages.keys())
    if (
      index >= state.messages.length ||
      state.messages[index].role === "toolResult"
    )
      cache.messages.delete(index);
  const children: HTMLElement[] = [];
  const shown = new Set<string>();
  const normalizedQuery = query.toLocaleLowerCase();
  for (const [index, message] of state.messages.entries()) {
    if (message.role === "toolResult") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block?.type === "text")
            .map((block) => block.text ?? "")
            .join("\n");
    if (query && !text.toLocaleLowerCase().includes(normalizedQuery)) continue;
    const toolIds = Array.isArray(message.content)
      ? message.content
          .filter((block) => block?.type === "toolCall" && tools.has(block.id))
          .map((block) => block.id as string)
      : [];
    const signature = JSON.stringify([
      message.role,
      message.content,
      message.errorMessage,
      toolIds,
    ]);
    let cached = cache.messages.get(index);
    if (!cached || cached.signature !== signature) {
      const node = element(
        "article",
        message.role === "user" ? "user-message" : "assistant-message",
      );
      renderContent(node, message, index, tools);
      const actions = element("div", "content-actions");
      if (message.role === "assistant" && text) {
        const copy = contentButton("复制回复");
        copy.dataset.copyText = text;
        actions.append(copy);
      }
      if (message.role === "user") {
        const edit = contentButton("修改后重新提问");
        edit.title = "从此消息分叉并恢复到输入框，不回滚文件";
        edit.dataset.messageIndex = String(index);
        actions.append(edit);
      }
      node.append(actions);
      if (message.errorMessage)
        node.append(element("pre", "error", message.errorMessage));
      if (cached) {
        const opened = new Set(
          [
            ...cached.node.querySelectorAll<HTMLDetailsElement>(
              "details[open][data-key]",
            ),
          ].map((details) => details.dataset.key),
        );
        cached.node.className = node.className;
        cached.node.replaceChildren(...node.childNodes);
        for (const details of cached.node.querySelectorAll<HTMLDetailsElement>(
          "details[data-key]",
        ))
          if (opened.has(details.dataset.key)) details.open = true;
        cached.signature = signature;
      } else {
        cached = { signature, node };
        cache.messages.set(index, cached);
      }
    }
    const edit = cached.node.querySelector<HTMLButtonElement>(
      "[data-message-index]",
    );
    if (edit && edit.disabled !== (state.connection !== "connected"))
      edit.disabled = state.connection !== "connected";
    for (const id of toolIds) shown.add(id);
    children.push(cached.node);
  }
  for (const tool of state.tools)
    if (!query && !shown.has(tool.id)) children.push(tools.get(tool.id)!);
  if (query && !children.length) {
    cache.noMatches ??= element(
      "p",
      "muted",
      "当前可见对话没有匹配消息；可搜索 PI 完整历史。",
    );
    children.push(cache.noMatches);
  }
  if (!state.messages.length) {
    if (!cache.empty) {
      cache.empty = element("div", "empty");
      cache.empty.append(
        element("div", "pi-mark", "π"),
        element("h1", "", "在这里，继续你的工作。"),
        element("p", "", "本机 PI 的模型、工具与技能，直接在编辑器中使用。"),
      );
    }
    children.push(cache.empty);
  }
  reconcileChildren(container, children);
  if (nearBottom) container.scrollTop = container.scrollHeight;
}
function renderContent(
  node: HTMLElement,
  message: AgentMessage,
  index: number,
  tools: Map<string, HTMLElement>,
) {
  if (typeof message.content === "string") {
    appendText(node, message.content);
    return;
  }
  for (const [blockIndex, block] of message.content.entries()) {
    if (!block) continue;
    if (block.type === "text") appendText(node, block.text ?? "");
    else if (block.type === "thinking") {
      const details = element("details", "thinking");
      details.dataset.key = `thinking-${index}-${blockIndex}`;
      details.append(
        element("summary", "", "思考"),
        element("div", "thinking-text", block.thinking ?? ""),
      );
      node.append(details);
    } else if (block.type === "image") appendImage(node, block);
    else if (block.type === "toolCall") {
      const tool = tools.get(block.id);
      if (tool) node.append(tool);
    }
  }
}
function appendText(node: HTMLElement, text: string) {
  const body = element("div", "markdown");
  body.innerHTML = renderMarkdown(text);
  for (const pre of body.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    if (!code) continue;
    const controls = element("div", "content-actions");
    const copy = contentButton("复制代码");
    copy.dataset.copyText = code.textContent ?? "";
    const open = contentButton("在编辑器打开");
    open.dataset.codeText = code.textContent ?? "";
    open.dataset.language = (
      code.className.match(/language-([\w+-]+)/)?.[1] ?? ""
    ).slice(0, 80);
    controls.append(copy, open);
    pre.after(controls);
  }
  node.append(body);
}
function contentButton(label: string): HTMLButtonElement {
  const button = element("button", "content-action", label);
  button.type = "button";
  return button;
}
function appendImage(node: HTMLElement, block: JsonObject) {
  if (
    typeof block.data !== "string" ||
    !/^image\/(png|jpeg|gif|webp)$/.test(block.mimeType ?? "") ||
    !/^[A-Za-z0-9+/=\s]+$/.test(block.data)
  )
    return;
  const image = element("img", "content-image");
  image.alt = "PI 图片";
  image.src = `data:${block.mimeType};base64,${block.data}`;
  node.append(image);
}
export function renderTool(tool: ToolView) {
  const details = element("details", `tool ${tool.status}`);
  details.dataset.key = `tool-${tool.id}`;
  const marker =
    tool.status === "pending" ? "·" : tool.status === "success" ? "✓" : "×";
  const label = `${marker} ${tool.name}  ${String(tool.args.path ?? tool.args.command ?? "").slice(0, 140)}`;
  details.append(
    element("summary", "", label),
    element("pre", "tool-args", JSON.stringify(tool.args, null, 2)),
  );
  if (typeof tool.args.path === "string") {
    const open = contentButton("打开文件");
    open.dataset.reference = tool.args.path;
    details.append(open);
  }
  const content = tool.result?.content;
  for (const block of Array.isArray(content) ? content : []) {
    if (!isObject(block)) continue;
    if (block.type === "text") {
      const text = String(block.text ?? "");
      details.append(
        element(
          "pre",
          "tool-output",
          text.slice(0, 30000) +
            (text.length > 30000 ? "\n…显示已截断（插件限制）" : ""),
        ),
      );
    } else if (block.type === "image") appendImage(details, block);
  }
  if (
    tool.name === "edit" &&
    tool.status !== "pending" &&
    tool.result?.details
  ) {
    const patch = tool.result.details.diff ?? tool.result.details.patch;
    if (typeof patch === "string") {
      details.append(
        element("div", "muted", "已修改 · 差异"),
        element(
          "pre",
          "diff",
          patch.slice(0, 30000) +
            (patch.length > 30000 ? "\n…显示已截断（插件限制）" : ""),
        ),
      );
    }
  }
  if (tool.durationMs !== undefined)
    details.append(element("small", "muted", `${tool.durationMs} ms`));
  return details;
}
