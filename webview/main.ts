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
import { PromptHistory, setupComposer } from "./composer";
import { parseBuiltinCommand } from "../src/shared/commands";
import type { WaSelectEvent } from "@awesome.me/webawesome/dist/events/select.js";
import "./forms.css";
declare function acquireVsCodeApi(): {
  postMessage(message: ClientAction): void;
  getState():
    { draft?: string; editorRevision?: number; history?: string[] } | undefined;
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
let stoppingFromPrompt = false;
let promotingRevision: number | undefined;
let submittedText = "";
let editorRevision = restored?.editorRevision ?? 0;
let composing = false;
const inputHistory = new PromptHistory(restored?.history);
function saveDraft() {
  vscode.setState({
    draft: promptText(),
    editorRevision,
    ...(inputHistory.entries.length ? { history: inputHistory.entries } : {}),
  });
}
const composer = setupComposer(
  prompt,
  byId("command-menu"),
  post,
  () => state?.commands ?? [],
  () => {
    saveDraft();
    updateSend();
  },
  inputHistory,
);
byId<FormInput>("conversation-search").addEventListener("input", () => {
  if (state)
    renderChat(
      byId("transcript"),
      state,
      byId<FormInput>("conversation-search").value ?? "",
    );
});
for (const channel of ["steering", "followUp"] as const) {
  byId<FormSelect>(`${channel}-mode`).addEventListener("change", () => {
    const mode = byId<FormSelect>(`${channel}-mode`).value;
    if (mode === "all" || mode === "one-at-a-time")
      post({ type: "queueMode", channel, mode });
  });
}
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
  composer.refresh();
});
prompt.addEventListener("keydown", (event) => {
  if (composing || event.isComposing) return;
  if (composer.keydown(event)) return;
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
  inputHistory.reset();
  saveDraft();
  if (!composing) composer.refresh();
  updateSend();
});
prompt.addEventListener("click", () => {
  if (!composing) composer.refresh();
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
  if (state?.connection === "connected" && isStopCommand() && !composing) {
    if (stoppingFromPrompt) return;
    stoppingFromPrompt = true;
    updateSend();
    post({
      type: "send",
      text: promptText(),
      attachmentIds: [],
      mode: "followUp",
    });
    return;
  }
  if (
    !state ||
    state.connection !== "connected" ||
    submitting ||
    state.queueControl?.busy ||
    promotingRevision !== undefined ||
    composer.isAttaching ||
    composing ||
    (!promptText().trim() && !state.attachments.length)
  )
    return;
  submittedText = promptText();
  if (submittedText.startsWith("!"))
    byId<HTMLDetailsElement>("shell-panel").open = true;
  submitting = true;
  updateSend();
  post({
    type: "send",
    text: submittedText,
    attachmentIds: state.attachments.map((a) => a.id),
    mode: "followUp",
  });
}
function isStopCommand() {
  const command = parseBuiltinCommand(promptText(), state?.commands);
  return command?.name === "stop" && !command.args;
}
function updateSend() {
  byId<FormButton>("send").disabled =
    (isStopCommand()
      ? stoppingFromPrompt
      : submitting ||
        !!state?.queueControl?.busy ||
        promotingRevision !== undefined) || state?.connection !== "connected";
}
window.addEventListener("message", ({ data }: MessageEvent<HostMessage>) => {
  if (data.type === "showControl") {
    selections.show(data.control);
    return;
  }
  if (data.type === "commandCompleted") {
    stoppingFromPrompt = false;
    inputHistory.record(data.text);
    if (promptText() === data.text) prompt.value = "";
    saveDraft();
    renderCommands();
    updateSend();
    return;
  }
  if (data.type === "fileCandidates" || data.type === "contextAttached") {
    composer.receive(data);
    return;
  }
  if (data.type === "sent") {
    if (submitting && !data.preserveDraft) inputHistory.record(submittedText);
    submitting = false;
    if (!data.preserveDraft && promptText() === submittedText)
      prompt.value = "";
    saveDraft();
    renderCommands();
    updateSend();
    renderQueue();
    return;
  }
  if (data.type !== "snapshot") return;
  state = data.state;
  if (
    state.error ||
    state.queueControl?.revision !== promotingRevision ||
    state.queueControl?.busy
  )
    promotingRevision = undefined;
  selections.render(state);
  if (state.error) {
    submitting = false;
    stoppingFromPrompt = false;
  }
  renderChat(
    byId("transcript"),
    state,
    byId<FormInput>("conversation-search").value ?? "",
  );
  renderState();
  if (state.editorText && state.editorText.revision !== editorRevision) {
    editorRevision = state.editorText.revision;
    prompt.value = state.editorText.append
      ? [promptText(), state.editorText.text].filter(Boolean).join("\n\n")
      : state.editorText.text;
    saveDraft();
    renderCommands();
    if (state.editorText.focus) {
      prompt.focus({ preventScroll: true });
      prompt.scrollIntoView({ block: "nearest" });
    }
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
  byId("queue-send-hint").hidden = state.run !== "running";
  byId("send").title =
    state.run === "running" ? "发送后续消息 · Enter" : "发送消息 · Enter";
  byId("model-name").textContent =
    state.model?.name ?? state.model?.id ?? "选择模型";
  byId("thinking-name").textContent = state.thinkingLevel ?? "思考";
  for (const id of ["model", "thinking", "auto-compaction", "auto-retry"])
    byId<FormButton | FormSwitch>(id).disabled =
      state.connection !== "connected";
  const statuses = Object.values(state.statuses).join(" · ");
  byId("statuses").textContent = statuses;
  byId("statuses").hidden = !statuses;
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
  const usage = byId<HTMLButtonElement>("usage");
  usage.disabled =
    state.connection !== "connected" ||
    state.run !== "idle" ||
    !!state.compaction.active ||
    !!state.queueControl?.busy;
  usage.setAttribute("aria-busy", String(!!state.compaction.active));
  usage.title =
    state.connection !== "connected"
      ? "连接 PI 后可手动压缩上下文"
      : state.compaction.active
        ? "正在压缩上下文…"
        : state.run !== "idle" || state.queueControl?.busy
          ? "当前任务结束后可手动压缩上下文"
          : "点击手动压缩上下文";
  usage.setAttribute("aria-label", `${usage.textContent} · ${usage.title}`);
  if (state.compaction.active) usage.append(" · 正在压缩…");
  byId<FormSwitch>("auto-compaction").checked = !!state.compaction.enabled;
  byId<FormSwitch>("auto-retry").checked = !!state.retry.enabled;
  for (const channel of ["steering", "followUp"] as const) {
    const select = byId<FormSelect>(`${channel}-mode`);
    select.value = state.queueModes?.[channel] ?? "";
    select.disabled = state.connection !== "connected";
  }
  byId("retry-known").textContent =
    state.retry.enabled === undefined ? "（当前设置未知）" : "";
  const activity = byId("activity");
  const keepWorking =
    state.run === "running" &&
    !state.retry.active &&
    !state.compaction.active &&
    !!activity.querySelector(".working");
  if (keepWorking) {
    for (const child of Array.from(activity.children))
      if (!child.classList.contains("working")) child.remove();
  } else activity.replaceChildren();
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
  else if (state.run === "running") {
    if (!keepWorking) {
      const working = element("span", "working");
      working.setAttribute("role", "status");
      working.setAttribute("aria-label", "PI 正在工作");
      const spinner = element("span", "working-spinner");
      spinner.setAttribute("aria-hidden", "true");
      working.append(spinner, document.createTextNode("Working"));
      activity.append(working);
    }
  } else if (state.compaction.result?.summary) {
    const summary = element("details");
    summary.append(
      element("summary", "", "上下文已压缩 · 查看摘要"),
      element("div", "", state.compaction.result.summary),
    );
    activity.append(summary);
  }
  if (state.compaction.error)
    activity.append(element("span", "error", state.compaction.error));
  if (state.compaction.notice) {
    const notice = element("span", "muted", state.compaction.notice);
    notice.setAttribute("role", "status");
    activity.append(notice);
  }
  if (state.pendingUi.length)
    activity.append(
      element("span", "muted", "PI 正等待交互，请查看 VS Code 提示。"),
    );
  const attachments = byId("attachments");
  attachments.replaceChildren();
  for (const item of state.attachments) {
    const chip = element("span", "attachment");
    chip.title = item.preview;
    const label = item.reference
      ? formButton(item.name)
      : element(
          "span",
          "",
          item.kind === "image" ? `▧ ${item.name}` : item.name,
        );
    if (item.reference)
      label.onclick = () =>
        post({ type: "openFile", reference: item.reference! });
    chip.append(label);
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
  renderQueue();
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
      : `命令退出码：${state.shell.exitCode}`,
    !state.shell?.active && state.shell?.exitCode === 127
      ? "未找到 Bash 命令（127）。请检查命令名称及运行环境；如需向 AI 提问，请使用上方聊天输入框。"
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  renderCommands();
}
function renderQueue() {
  if (!state) return;
  const queue = byId("queue");
  queue.replaceChildren();
  queue.hidden = !state.queues.steering.length && !state.queues.followUp.length;
  for (const [kind, items] of Object.entries(state.queues))
    items.forEach((text, index) => {
      const row = element("div", "queue-item");
      row.append(
        element(
          "span",
          "queue-text",
          `${kind === "steering" ? "补充指示" : "后续消息"} · ${text}`,
        ),
      );
      if (kind === "followUp") {
        const control = state!.queueControl;
        const steer = formButton("引导", "queue-steer");
        steer.dataset.steerIndex = String(index);
        steer.disabled =
          !control?.canSteer || submitting || promotingRevision !== undefined;
        steer.title =
          control?.reason ??
          "转为补充指示；仅适用于未被输入扩展改变的纯文本，输入扩展会再次执行";
        steer.setAttribute("aria-label", `引导第 ${index + 1} 条后续消息`);
        steer.onclick = () => {
          if (steer.disabled || !control) return;
          promotingRevision = control.revision;
          for (const button of queue.querySelectorAll<FormButton>("wa-button"))
            button.disabled = true;
          updateSend();
          post({ type: "promoteQueued", index, revision: control.revision });
        };
        row.append(steer);
      }
      queue.append(row);
    });
  if (!queue.hidden) {
    const control = state.queueControl;
    queue.append(
      element(
        "small",
        "muted queue-hint",
        control?.reason ??
          "仅适用于纯文本；输入扩展会再次执行，请勿用于扩展自动添加图片的队列。",
      ),
    );
    const clear = formButton("清空并恢复到输入框");
    clear.disabled =
      !!control?.busy || submitting || promotingRevision !== undefined;
    clear.onclick = () => post({ type: "clearQueue" });
    queue.append(clear);
  }
}
function renderCommands() {
  if (!composing) composer.refresh();
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
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "button.content-action",
  );
  if (button) {
    if (button.dataset.copyText !== undefined)
      post({ type: "copyText", text: button.dataset.copyText });
    else if (button.dataset.codeText !== undefined)
      post({
        type: "openCode",
        text: button.dataset.codeText,
        language: button.dataset.language ?? "",
      });
    else if (button.dataset.messageIndex !== undefined)
      post({ type: "forkMessage", index: Number(button.dataset.messageIndex) });
    else if (button.dataset.reference)
      post({ type: "openFile", reference: button.dataset.reference });
    return;
  }
  const link = (event.target as HTMLElement).closest("a");
  if (link) {
    event.preventDefault();
    if (link.dataset.reference)
      post({ type: "openFile", reference: link.dataset.reference });
    else if (/^https?:\/\//i.test(link.href))
      post({ type: "openLink", url: link.href });
  }
});
post({ type: "ready" });
