import type {
  ClientAction,
  HostMessage,
  ViewState,
} from "../src/shared/bridge";
import { renderChat, shouldSend, element } from "./chat";
import {
  formButton,
  type FormButton,
  type FormInput,
  type FormSelect,
  type FormSwitch,
  type FormTextarea,
} from "./components";
import { moreActions, sidebarMarkup } from "./layout";
import { setupSelections } from "./selections";
import type { WaSelectEvent } from "@awesome.me/webawesome/dist/events/select.js";
import "./forms.css";
declare function acquireVsCodeApi(): {
  postMessage(message: ClientAction): void;
  getState(): { draft?: string; editorRevision?: number } | undefined;
  setState(state: unknown): void;
};
const vscode = acquireVsCodeApi();
const post = (action: ClientAction) => vscode.postMessage(action);
const root = document.getElementById("app")!;
root.innerHTML = sidebarMarkup;
const byId = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const selections = setupSelections(root, post);
const prompt = byId<FormTextarea>("prompt");
const promptText = () => prompt.value ?? "";
const restored = vscode.getState();
prompt.value = restored?.draft ?? "";
let state: ViewState | undefined;
let submitting = false;
let submittedText = "";
let editorRevision = restored?.editorRevision ?? 0;
let composing = false;
for (const button of root.querySelectorAll<FormButton>("[data-action]"))
  button.onclick = () => post({ type: button.dataset.action } as ClientAction);
byId("actions").addEventListener("wa-select", (event) => {
  const item = (event as WaSelectEvent).detail.item;
  const action = moreActions.find(
    ([type]) => type === item.getAttribute("value"),
  );
  if (action) post({ type: action[0] });
});
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
  vscode.setState({ draft: promptText(), editorRevision });
  renderCommands();
});
byId<FormSwitch>("auto-compaction").onchange = () =>
  post({
    type: "autoCompaction",
    enabled: byId<FormSwitch>("auto-compaction").checked,
  });
byId<FormSwitch>("auto-retry").onchange = () =>
  post({
    type: "autoRetry",
    enabled: byId<FormSwitch>("auto-retry").checked,
  });
byId<FormInput>("shell-command").addEventListener("input", updateShellControls);
byId("run-shell").onclick = () => {
  if (byId<FormButton>("run-shell").disabled) return;
  post({
    type: "shell",
    command: byId<FormInput>("shell-command").value ?? "",
    excludeFromContext: byId<FormSwitch>("shell-exclude").checked,
  });
};
function updateShellControls() {
  byId<FormButton>("run-shell").disabled =
    state?.connection !== "connected" ||
    !!state.shell?.active ||
    !byId<FormInput>("shell-command").value?.trim();
  byId("cancel-shell").hidden = !state?.shell?.active;
}
function send() {
  if (
    !state ||
    state.connection !== "connected" ||
    submitting ||
    composing ||
    (!promptText().trim() && !state.attachments.length)
  )
    return;
  submittedText = promptText();
  submitting = true;
  updateSend();
  post({
    type: "send",
    text: submittedText,
    attachmentIds: state.attachments.map((a) => a.id),
    mode: byId<FormSelect>("mode").value === "steer" ? "steer" : "followUp",
  });
}
function updateSend() {
  byId<FormButton>("send").disabled =
    submitting || state?.connection !== "connected";
}
window.addEventListener("message", ({ data }: MessageEvent<HostMessage>) => {
  if (data.type === "sent") {
    submitting = false;
    if (promptText() === submittedText) prompt.value = "";
    vscode.setState({ draft: promptText(), editorRevision });
    renderCommands();
    updateSend();
    return;
  }
  if (data.type !== "snapshot") return;
  state = data.state;
  selections.render(state);
  if (state.error) submitting = false;
  renderChat(byId("transcript"), state);
  renderState();
  if (state.editorText && state.editorText.revision !== editorRevision) {
    editorRevision = state.editorText.revision;
    prompt.value = state.editorText.append
      ? [promptText(), state.editorText.text].filter(Boolean).join("\n\n")
      : state.editorText.text;
    vscode.setState({ draft: promptText(), editorRevision });
    renderCommands();
  }
});
function renderState() {
  if (!state) return;
  updateSend();
  updateShellControls();
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
    const button = formButton(
      state.connection === "error" ? "重新连接" : "连接 PI",
    );
    button.appearance = "outlined";
    button.disabled = state.connection === "connecting";
    button.onclick = () => post({ type: "connect" });
    connection.append(button);
  }
  connection.hidden = state.connection === "connected";
  byId("stop").hidden = state.run === "idle" && !state.compaction.active;
  byId("run-controls").hidden = byId("stop").hidden;
  byId("model-name").textContent =
    state.model?.name ?? state.model?.id ?? "选择模型";
  byId("thinking-name").textContent = state.thinkingLevel ?? "思考";
  for (const id of ["model", "thinking", "auto-compaction", "auto-retry"])
    byId<FormButton | FormSwitch>(id).disabled =
      state.connection !== "connected";
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
  byId<FormSwitch>("auto-compaction").checked = !!state.compaction.enabled;
  byId<FormSwitch>("auto-retry").checked = !!state.retry.enabled;
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
    const cancel = formButton("取消重试");
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
    const remove = formButton("×");
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
    const clear = formButton("清空并恢复到输入框");
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
  const match = promptText().match(/^\/([^\s]*)$/);
  menu.hidden = !match;
  if (!match) return;
  const commands =
    state?.commands.filter((cmd) =>
      cmd.name.toLowerCase().includes(match[1].toLowerCase()),
    ) ?? [];
  if (!commands.length)
    menu.append(element("div", "muted", "没有可发现的 PI 命令"));
  for (const cmd of commands.slice(0, 30)) {
    const button = formButton(
      `/${cmd.name} · ${cmd.description ?? cmd.source}`,
      "command-option",
    );
    button.onclick = () => {
      prompt.value = `/${cmd.name} `;
      vscode.setState({ draft: promptText(), editorRevision });
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
