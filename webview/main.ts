import type {
  ClientAction,
  HostMessage,
  ViewState,
} from "../src/shared/bridge";
import { renderChat, shouldSend, element } from "./chat";
declare function acquireVsCodeApi(): {
  postMessage(message: ClientAction): void;
  getState(): { draft?: string; editorRevision?: number } | undefined;
  setState(state: unknown): void;
};
const vscode = acquireVsCodeApi();
const post = (action: ClientAction) => vscode.postMessage(action);
const root = document.getElementById("app")!;
root.innerHTML = `<header><strong>π</strong><span id="title">PI</span><div class="spacer"></div><button data-action="newSession" aria-label="新建会话">＋</button><button data-action="sessions">历史</button><select id="actions" aria-label="更多操作"><option value="">⋯</option><option value="renameSession">重命名会话</option><option value="openSession">打开 PI 会话文件</option><option value="compact">压缩上下文</option><option value="fork">分叉（不回滚文件）</option><option value="clone">复制（不回滚文件）</option><option value="tree">浏览历史树</option><option value="export">导出 HTML</option><option value="settings">插件设置</option><option value="disconnect">断开</option></select></header>
<div id="error" role="alert" hidden></div><div id="connection"></div><main id="transcript" aria-label="PI 对话" tabindex="0"></main><section id="activity" aria-live="polite"></section><div id="widgets-above"></div><section id="queue" hidden></section>
<footer><div id="attachments"></div><div id="command-menu" hidden></div><textarea id="prompt" rows="3" aria-label="发送给 PI" placeholder="向 PI 提问… 输入 / 查看技能与命令"></textarea><div class="input-actions"><button data-action="attachFiles">＋ 附件</button><button data-action="attachSelection">选区</button><div class="spacer"></div><select id="mode" aria-label="运行时发送方式"><option value="followUp">后续消息</option><option value="steer">补充指示</option></select><button id="send" class="primary">发送 ↵</button><button data-action="stop" id="stop" hidden>停止全部</button></div><div class="statusline"><button data-action="chooseModel" id="model">模型</button><button data-action="chooseThinking" id="thinking">思考</button><span id="usage"></span></div><div class="statusline"><span id="cwd"></span><span id="statuses"></span></div><details class="preferences"><summary>上下文与重试</summary><label><input type="checkbox" id="auto-compaction">自动压缩</label><label><input type="checkbox" id="auto-retry">自动重试<span id="retry-known"></span></label><button data-action="compact">手动压缩</button></details></footer><div id="widgets-below"></div>
<details id="shell-panel"><summary>PI 命令</summary><p class="muted">由 PI 执行；默认输出在下一次请求时加入上下文。</p><input id="shell-command" aria-label="PI shell 命令" placeholder="输入命令"><label><input type="checkbox" id="shell-exclude">不加入上下文</label><button id="run-shell">运行</button><button data-action="cancelShell">取消命令</button><pre id="shell-output"></pre></details>`;
const byId = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const prompt = byId<HTMLTextAreaElement>("prompt");
const restored = vscode.getState();
prompt.value = restored?.draft ?? "";
let state: ViewState | undefined;
let submitting = false;
let submittedText = "";
let editorRevision = restored?.editorRevision ?? 0;
let composing = false;
for (const button of root.querySelectorAll<HTMLButtonElement>("[data-action]"))
  button.onclick = () => post({ type: button.dataset.action } as ClientAction);
byId<HTMLSelectElement>("actions").onchange = (event) => {
  const select = event.target as HTMLSelectElement;
  if (select.value) post({ type: select.value } as ClientAction);
  select.value = "";
};
byId("send").onclick = send;
prompt.addEventListener("compositionstart", () => {
  composing = true;
});
prompt.addEventListener("compositionend", () => {
  composing = false;
});
prompt.addEventListener("keydown", (event) => {
  if (
    shouldSend({
      key: event.key,
      isComposing: event.isComposing || composing,
      shiftKey: event.shiftKey,
    })
  ) {
    event.preventDefault();
    send();
  }
});
prompt.addEventListener("input", () => {
  vscode.setState({ draft: prompt.value, editorRevision });
  renderCommands();
});
byId<HTMLInputElement>("auto-compaction").onchange = (event) =>
  post({
    type: "autoCompaction",
    enabled: (event.target as HTMLInputElement).checked,
  });
byId<HTMLInputElement>("auto-retry").onchange = (event) =>
  post({
    type: "autoRetry",
    enabled: (event.target as HTMLInputElement).checked,
  });
byId("run-shell").onclick = () =>
  post({
    type: "shell",
    command: byId<HTMLInputElement>("shell-command").value,
    excludeFromContext: byId<HTMLInputElement>("shell-exclude").checked,
  });
function send() {
  if (
    !state ||
    state.connection !== "connected" ||
    submitting ||
    composing ||
    (!prompt.value.trim() && !state.attachments.length)
  )
    return;
  submittedText = prompt.value;
  submitting = true;
  updateSend();
  post({
    type: "send",
    text: submittedText,
    attachmentIds: state.attachments.map((a) => a.id),
    mode: byId<HTMLSelectElement>("mode").value as "steer" | "followUp",
  });
}
function updateSend() {
  byId<HTMLButtonElement>("send").disabled =
    submitting || state?.connection !== "connected";
}
window.addEventListener("message", ({ data }: MessageEvent<HostMessage>) => {
  if (data.type === "sent") {
    submitting = false;
    if (prompt.value === submittedText) prompt.value = "";
    vscode.setState({ draft: prompt.value, editorRevision });
    renderCommands();
    updateSend();
    return;
  }
  if (data.type !== "snapshot") return;
  state = data.state;
  if (state.error) submitting = false;
  renderChat(byId("transcript"), state);
  renderState();
  if (state.editorText && state.editorText.revision !== editorRevision) {
    editorRevision = state.editorText.revision;
    prompt.value = state.editorText.append
      ? [prompt.value, state.editorText.text].filter(Boolean).join("\n\n")
      : state.editorText.text;
    vscode.setState({ draft: prompt.value, editorRevision });
    renderCommands();
  }
});
function renderState() {
  if (!state) return;
  updateSend();
  byId("title").textContent = state.title ?? state.session?.name ?? "PI";
  const error = byId("error");
  error.hidden = !state.error;
  error.textContent = state.error ?? "";
  const connection = byId("connection");
  connection.replaceChildren();
  if (state.connection !== "connected") {
    connection.append(
      element(
        "span",
        "muted",
        state.connection === "connecting"
          ? "正在连接本机 PI…"
          : "本机 PI 尚未连接",
      ),
    );
    const button = element(
      "button",
      "",
      state.connection === "error" ? "重新连接" : "连接 PI",
    );
    button.disabled = state.connection === "connecting";
    button.onclick = () => post({ type: "connect" });
    connection.append(button);
  }
  connection.hidden = state.connection === "connected";
  byId("stop").hidden = state.run === "idle" && !state.compaction.active;
  byId("model").textContent =
    state.model?.name ?? state.model?.id ?? "选择模型";
  byId("thinking").textContent = state.thinkingLevel ?? "思考";
  byId("cwd").textContent = state.workspace ?? "打开本地工作区后连接";
  byId("cwd").title = state.workspace ?? "";
  byId("statuses").textContent = Object.values(state.statuses).join(" · ");
  const stats = state.stats;
  const tokens = stats?.tokens?.total;
  const cost = stats?.cost;
  const context = stats?.contextUsage;
  const percent = context?.percent;
  byId("usage").textContent = [
    tokens === undefined ? "" : `${tokens.toLocaleString()} tokens`,
    cost === undefined ? "" : `$${cost.toFixed(4)}`,
    !context
      ? "上下文不可用"
      : percent == null
        ? "上下文等待更新"
        : `上下文 ${percent.toFixed(1)}%`,
  ]
    .filter(Boolean)
    .join(" · ");
  byId<HTMLInputElement>("auto-compaction").checked =
    !!state.compaction.enabled;
  byId<HTMLInputElement>("auto-retry").checked = !!state.retry.enabled;
  byId("retry-known").textContent =
    state.retry.enabled === undefined ? "（当前设置未知）" : "";
  const activity = byId("activity");
  activity.replaceChildren();
  if (state.retry.active) {
    activity.append(
      element(
        "span",
        "",
        `正在重试 ${state.retry.attempt ?? ""} · ${state.retry.errorMessage ?? ""}`,
      ),
    );
    const cancel = element("button", "", "取消重试");
    cancel.onclick = () => post({ type: "cancelRetry" });
    activity.append(cancel);
  } else if (state.compaction.active)
    activity.append(element("span", "", "正在压缩上下文…"));
  else if (state.run === "running")
    activity.append(element("span", "working", "PI 正在工作…"));
  else if (state.compaction.result?.summary) {
    const summary = element("details");
    summary.append(
      element("summary", "", "上下文已压缩 · 查看摘要"),
      element("div", "", state.compaction.result.summary),
    );
    activity.append(summary);
  }
  if (state.compaction.error)
    activity.append(element("span", "error", state.compaction.error));
  if (state.pendingUi.length)
    activity.append(
      element("span", "muted", "PI 正等待交互，请查看 VS Code 提示。"),
    );
  const attachments = byId("attachments");
  attachments.replaceChildren();
  for (const item of state.attachments) {
    const chip = element("span", "attachment");
    chip.title = item.preview;
    chip.append(
      element("span", "", item.kind === "image" ? `▧ ${item.name}` : item.name),
    );
    const remove = element("button", "", "×");
    remove.setAttribute("aria-label", `移除 ${item.name}`);
    remove.onclick = () => post({ type: "removeAttachment", id: item.id });
    chip.append(remove);
    attachments.append(chip);
  }
  if (
    state.attachments.some((a) => a.kind === "image") &&
    !state.model?.input?.includes("image")
  )
    attachments.append(
      element("p", "error", "当前模型不支持图片，请切换模型或移除图片。"),
    );
  const queue = byId("queue");
  queue.replaceChildren();
  queue.hidden = !state.queues.steering.length && !state.queues.followUp.length;
  for (const [kind, items] of Object.entries(state.queues))
    for (const text of items)
      queue.append(
        element(
          "div",
          "queue-item",
          `${kind === "steering" ? "补充指示" : "后续消息"} · ${text}`,
        ),
      );
  if (!queue.hidden) {
    queue.append(element("small", "muted", "补充指示在当前工具完成后处理。"));
    const clear = element("button", "", "清空并恢复到输入框");
    clear.onclick = () => post({ type: "clearQueue" });
    queue.append(clear);
  }
  for (const placement of ["aboveEditor", "belowEditor"]) {
    const target = byId(
      placement === "aboveEditor" ? "widgets-above" : "widgets-below",
    );
    target.replaceChildren();
    for (const widget of Object.values(state.widgets))
      if (widget.placement === placement)
        target.append(element("pre", "widget", widget.lines.join("\n")));
  }
  byId("shell-output").textContent = [
    state.shell?.active && state.shell?.previewTruncated
      ? "[插件预览已截断，仅显示末尾内容]"
      : "",
    state.shell?.output ?? "",
    state.shell?.error ? `错误：${state.shell.error}` : "",
    state.shell?.exitCode === undefined
      ? ""
      : `退出码：${state.shell.exitCode}`,
  ]
    .filter(Boolean)
    .join("\n");
  renderCommands();
}
function renderCommands() {
  const menu = byId("command-menu");
  menu.replaceChildren();
  const match = prompt.value.match(/^\/([^\s]*)$/);
  menu.hidden = !match;
  if (!match) return;
  const commands =
    state?.commands.filter((cmd) =>
      cmd.name.toLowerCase().includes(match[1].toLowerCase()),
    ) ?? [];
  if (!commands.length)
    menu.append(element("div", "muted", "没有可发现的 PI 命令"));
  for (const cmd of commands.slice(0, 30)) {
    const button = element(
      "button",
      "command-option",
      `/${cmd.name} · ${cmd.description ?? cmd.source}`,
    );
    button.onclick = () => {
      prompt.value = `/${cmd.name} `;
      vscode.setState({ draft: prompt.value, editorRevision });
      menu.hidden = true;
      prompt.focus();
    };
    menu.append(button);
  }
}
async function attachImage(file: File) {
  if (file.size > 5 * 1024 * 1024) {
    byId("error").hidden = false;
    byId("error").textContent = "插件图片限制：每张 5 MiB，合计 15 MiB。";
    return;
  }
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  post({
    type: "image",
    data,
    mimeType: file.type,
    name: file.name || "粘贴图片",
  });
}
prompt.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files ?? [])].filter((file) =>
    file.type.startsWith("image/"),
  );
  if (files.length) {
    event.preventDefault();
    for (const file of files) void attachImage(file);
  }
});
root.addEventListener("dragover", (event) => event.preventDefault());
root.addEventListener("drop", (event) => {
  event.preventDefault();
  for (const file of event.dataTransfer?.files ?? [])
    if (file.type.startsWith("image/")) void attachImage(file);
});
root.addEventListener("click", (event) => {
  const link = (event.target as HTMLElement).closest("a");
  if (link) {
    event.preventDefault();
    if (/^https?:\/\//i.test(link.href))
      post({ type: "openLink", url: link.href });
  }
});
post({ type: "ready" });
