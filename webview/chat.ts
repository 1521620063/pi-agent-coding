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
interface ActivityNode {
  node: HTMLDetailsElement;
  summary: HTMLElement;
  label: HTMLElement;
  count: HTMLElement;
  failure: HTMLElement;
  current: HTMLElement;
  preview: HTMLElement;
  elapsed: HTMLElement;
  previewSuppressed: boolean;
  wasActive: boolean;
  interrupted: boolean;
  body: HTMLElement;
}
interface ChatCache {
  context: string;
  messages: Map<number, CachedNode>;
  tools: Map<string, CachedNode>;
  activities: Map<number, ActivityNode>;
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

// Keep commentary and tool calls together, leaving the response after the last
// operation visible. User/custom messages are boundaries; tool results are not.
function activityMembership(messages: AgentMessage[]) {
  const membership = new Map<number, number>();
  let start = 0;
  let lastOperation = -1;
  const flush = () => {
    for (let index = start; index <= lastOperation; index++)
      if (messages[index].role === "assistant") membership.set(index, start);
    lastOperation = -1;
  };
  for (const [index, message] of messages.entries()) {
    if (message.role === "toolResult") continue;
    if (message.role !== "assistant") {
      flush();
      start = index + 1;
    } else if (
      Array.isArray(message.content) &&
      (message.content.some((block) => block?.type === "toolCall") ||
        (message.content.some((block) => block?.type === "thinking") &&
          !message.content.some(
            (block) =>
              block?.type === "image" ||
              (block?.type === "text" && String(block.text ?? "").trim()),
          )))
    )
      lastOperation = index;
  }
  flush();
  return membership;
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
    cache = {
      context,
      messages: new Map(),
      tools: new Map(),
      activities: new Map(),
    };
    chats.set(container, cache);
  }
  const tools = new Map<string, HTMLElement>();
  const toolRecords = new Map(state.tools.map((tool) => [tool.id, tool]));
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
  let lastUser = -1;
  for (const [index, message] of state.messages.entries())
    if (message.role === "user") lastUser = index;
  const activeKey = lastUser + 1;
  const live =
    state.connection === "connected" &&
    (state.run === "running" ||
      !!state.compaction.active ||
      state.pendingUi.length > 0);
  const membership = query
    ? new Map<number, number>()
    : activityMembership(state.messages);
  const activities = new Map<
    number,
    { children: HTMLElement[]; tools: Set<string> }
  >();
  const appendActivity = (
    key: number,
    node?: HTMLElement,
    toolIds: string[] = [],
  ) => {
    let activity = activities.get(key);
    if (!activity) {
      activity = { children: [], tools: new Set() };
      activities.set(key, activity);
      let cached = cache.activities.get(key);
      if (!cached) {
        const details = element("details", "execution");
        const summary = element("summary", "execution-summary");
        summary.title = "展开或收起完整执行过程；运行预览最多显示三行";
        const icon = element("span", "execution-icon");
        icon.setAttribute("aria-hidden", "true");
        for (let index = 0; index < 3; index++)
          icon.append(element("span", "activity-bar"));
        const heading = element("span", "execution-heading");
        const labels = element("span", "execution-labels");
        const label = element("span", "execution-label");
        label.setAttribute("role", "status");
        const count = element("span", "execution-count");
        const failure = element("span", "execution-failure");
        failure.title = "工具返回异常，展开查看详情";
        const elapsed = element("span", "execution-elapsed");
        const current = element("span", "execution-current");
        const preview = element("span", "execution-preview");
        preview.hidden = true;
        const chevron = element("span", "execution-chevron");
        chevron.setAttribute("aria-hidden", "true");
        labels.append(label, count, failure, elapsed);
        heading.append(labels, current, preview);
        summary.append(icon, heading, chevron);
        const body = element("div", "execution-body");
        details.append(summary, body);
        cached = {
          node: details,
          summary,
          label,
          count,
          failure,
          current,
          preview,
          elapsed,
          previewSuppressed: false,
          wasActive: false,
          interrupted: false,
          body,
        };
        const activityNode = cached;
        details.addEventListener("toggle", () => {
          // Native disclosure is only changed by the user. Keep their choice
          // through subsequent phases; streaming must never reopen a disclosure.
          activityNode.previewSuppressed = !details.open;
          if (!details.open) activityNode.preview.hidden = true;
        });
        cache.activities.set(key, cached);
      }
      children.push(cached.node);
    }
    if (node) activity.children.push(node);
    for (const id of toolIds) activity.tools.add(id);
  };
  const shown = new Set<string>();
  const normalizedQuery = query.toLocaleLowerCase();
  for (const [index, message] of state.messages.entries()) {
    if (message.role === "toolResult") continue;
    if (!query && live && index > lastUser && !activities.has(activeKey))
      appendActivity(activeKey);
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
    const activityKey = membership.get(index);
    if (activityKey === undefined) children.push(cached.node);
    else appendActivity(activityKey, cached.node, toolIds);
  }
  if (!query && live && !activities.has(activeKey)) appendActivity(activeKey);
  for (const tool of state.tools)
    if (!query && !shown.has(tool.id)) {
      const key =
        [...activities.keys()].reverse().find((index) => index > lastUser) ??
        lastUser + 1;
      appendActivity(key, tools.get(tool.id)!, [tool.id]);
    }
  for (const [key, activity] of activities) {
    const cached = cache.activities.get(key)!;
    const records = [...activity.tools].map((id) => toolRecords.get(id)!);
    const pending = records.filter((tool) => tool.status === "pending");
    const errors = records.filter((tool) => tool.status === "error").length;
    const active = live && key === activeKey;
    if (active) cached.interrupted = false;
    else if (cached.wasActive && state.connection !== "connected")
      cached.interrupted = true;
    cached.wasActive = active;
    const interrupted = cached.interrupted || (pending.length > 0 && !active);
    const generation = active ? state.generation : undefined;
    const waitingUi = active && state.pendingUi.length > 0;
    const retrying = active && !!state.retry.active;
    const compacting = active && !!state.compaction.active;
    const label = interrupted
      ? "Interrupted"
      : waitingUi
        ? "Input needed"
        : retrying
          ? "Retrying"
          : compacting
            ? "Compacting"
            : pending.length
              ? "Running"
              : generation?.kind === "thinking"
                ? "Thinking"
                : generation?.kind === "text"
                  ? "Writing"
                  : generation?.kind === "toolCall"
                    ? "Preparing"
                    : active
                      ? "Waiting"
                      : "Activity";
    const count = records.length ? `${records.length} 项操作` : "";
    const failure = errors ? `${errors} 项异常` : "";
    const latest =
      pending.length && !interrupted && !waitingUi && !retrying && !compacting
        ? toolDescription(pending.at(-1)!)
        : undefined;
    const current = waitingUi
      ? "请查看 VS Code 中的交互提示"
      : retrying
        ? `第 ${state.retry.attempt ?? "未知"} 次 · ${String(state.retry.errorMessage ?? "等待 PI 重试")}`
        : latest
          ? `${latest.action}${latest.target ? ` · ${latest.target}` : ""}`
          : "";
    let preview = "";
    if (active && !waitingUi && !retrying && !compacting) {
      if (latest) {
        const tool = pending.at(-1)!;
        const content = tool.result?.content;
        // Bound the preview without copying an unbounded tool output.
        if (Array.isArray(content)) {
          for (const block of content)
            if (
              isObject(block) &&
              block.type === "text" &&
              typeof block.text === "string"
            )
              preview = (preview + block.text.slice(-600)).slice(-600);
        }
        preview ||= latest.target;
      } else if (generation?.kind === "thinking") {
        const message = state.messages[generation.messageIndex];
        const block = Array.isArray(message?.content)
          ? message.content[generation.contentIndex]
          : undefined;
        if (block?.type === "thinking" && typeof block.thinking === "string")
          preview = block.thinking.slice(-600);
      }
    }
    if (cached.preview.textContent !== preview)
      cached.preview.textContent = preview;
    const hidePreview = !preview || cached.previewSuppressed;
    if (cached.preview.hidden !== hidePreview)
      cached.preview.hidden = hidePreview;
    if (active && state.runStartedAt !== undefined) {
      const startedAt = String(state.runStartedAt);
      if (cached.elapsed.dataset.startedAt !== startedAt)
        cached.elapsed.dataset.startedAt = startedAt;
    } else if (cached.elapsed.dataset.startedAt !== undefined) {
      delete cached.elapsed.dataset.startedAt;
      cached.elapsed.textContent = "";
    }
    const hideElapsed = !active || state.runStartedAt === undefined;
    if (cached.elapsed.hidden !== hideElapsed)
      cached.elapsed.hidden = hideElapsed;
    const summary = [label, count, failure, current]
      .filter(Boolean)
      .join(" · ");
    if (cached.summary.getAttribute("aria-label") !== summary)
      cached.summary.setAttribute("aria-label", summary);
    for (const [node, text] of [
      [cached.label, label],
      [cached.count, count],
      [cached.failure, failure],
      [cached.current, current],
    ] as const) {
      if (node.textContent !== text) node.textContent = text;
      if (node.hidden !== !text) node.hidden = !text;
    }
    const className = `execution${errors || interrupted ? " has-error" : ""}${active && !waitingUi ? " is-running" : ""}`;
    if (cached.node.className !== className) cached.node.className = className;
    reconcileChildren(cached.body, activity.children);
  }
  // Retain collapsed/open state across filtering, but discard obsolete turns.
  for (const key of cache.activities.keys())
    if (!query && !activities.has(key)) cache.activities.delete(key);
  if (query && !children.length) {
    cache.noMatches ??= element(
      "p",
      "muted",
      "当前可见对话没有匹配消息；可搜索 PI 完整历史。",
    );
    children.push(cache.noMatches);
  }
  if (!state.messages.length && !live) {
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
  updateActivityElapsed(container);
  if (nearBottom) container.scrollTop = container.scrollHeight;
}

// Updating only these labels keeps selection, focus and transcript scroll intact.
export function updateActivityElapsed(
  container: HTMLElement,
  now = Date.now(),
) {
  for (const elapsed of container.querySelectorAll<HTMLElement>(
    ".execution-elapsed[data-started-at]",
  )) {
    const seconds = Math.max(
      0,
      Math.floor((now - Number(elapsed.dataset.startedAt)) / 1000),
    );
    const text =
      seconds < 60
        ? `${seconds} 秒`
        : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    if (elapsed.textContent !== text) elapsed.textContent = text;
  }
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
function toolDescription(tool: ToolView) {
  const actions: Record<string, string> = {
    read: "读取文件",
    write: "写入文件",
    edit: "编辑文件",
    bash: "运行命令",
    grep: "搜索内容",
    find: "查找文件",
    ls: "查看目录",
  };
  return {
    action: Object.hasOwn(actions, tool.name) ? actions[tool.name] : tool.name,
    target: String(
      tool.args.path ?? tool.args.command ?? tool.args.pattern ?? "",
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140),
  };
}
export function renderTool(tool: ToolView) {
  const details = element("details", `tool ${tool.status}`);
  details.dataset.key = `tool-${tool.id}`;
  const marker =
    tool.status === "pending" ? "·" : tool.status === "success" ? "✓" : "×";
  const { action, target } = toolDescription(tool);
  const summary = element("summary");
  const status = element("span", "tool-status", marker);
  status.setAttribute(
    "aria-label",
    { pending: "执行中", success: "成功", error: "失败" }[tool.status],
  );
  summary.append(status, element("span", "tool-action", action));
  if (target) summary.append(element("span", "tool-target", target));
  details.append(
    summary,
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
