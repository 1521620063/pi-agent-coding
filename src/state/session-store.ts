import {
  isObject,
  type PiRecord,
  type AgentMessage,
  type JsonObject,
} from "../pi/protocol";
import type { Unsubscribe, ViewState } from "../shared/bridge";
export class SessionStore {
  private state: ViewState = {
    connection: "disconnected",
    run: "idle",
    messages: [],
    tools: [],
    queues: { steering: [], followUp: [] },
    pendingUi: [],
    attachments: [],
    models: [],
    thinkingLevels: [],
    commands: [],
    compaction: {},
    retry: {},
    statuses: {},
    widgets: {},
  };
  private listeners = new Map<
    (state: ViewState) => void,
    readonly (keyof ViewState)[] | undefined
  >();
  private changeListeners = new Set<
    (changed: readonly (keyof ViewState)[]) => void
  >();
  private activeMessage: number | undefined;
  // An ID comparison alone misses reconnects and switching away and back.
  private revision = 0;
  get sessionRevision(): number {
    return this.revision;
  }
  getSnapshot(): ViewState {
    return structuredClone(this.state);
  }
  subscribe(
    listener: (state: ViewState) => void,
    keys?: readonly (keyof ViewState)[],
  ): Unsubscribe {
    this.listeners.set(listener, keys);
    return () => this.listeners.delete(listener);
  }
  subscribeChanges(
    listener: (changed: readonly (keyof ViewState)[]) => void,
  ): Unsubscribe {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }
  update(patch: Partial<ViewState>): void {
    if (
      ("connection" in patch && patch.connection !== this.state.connection) ||
      ("workspace" in patch && patch.workspace !== this.state.workspace) ||
      ("session" in patch &&
        (patch.session?.id !== this.state.session?.id ||
          patch.session?.path !== this.state.session?.path))
    )
      this.revision++;
    Object.assign(this.state, patch);
    const changed = Object.keys(patch) as (keyof ViewState)[];
    if (patch.run === "running" && this.state.runStartedAt === undefined) {
      this.state.runStartedAt = Date.now();
      changed.push("runStartedAt");
    }
    if (
      patch.run === "idle" ||
      (patch.connection && patch.connection !== "connected")
    ) {
      this.state.generation = undefined;
      this.state.runStartedAt = undefined;
      changed.push("generation", "runStartedAt");
    }
    this.emit(changed);
  }
  replaceMessages(messages: AgentMessage[]): void {
    messages = messages.filter(validMessage);
    this.activeMessage = undefined;
    this.state.generation = undefined;
    this.state.messages = structuredClone(messages);
    this.state.tools = [];
    const calls = new Map(
      messages.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content
              .filter(
                (block) =>
                  block?.type === "toolCall" && typeof block.id === "string",
              )
              .map((block) => [block.id, block] as const)
          : [],
      ),
    );
    for (const message of messages)
      if (
        message.role === "toolResult" &&
        typeof message.toolCallId === "string"
      )
        this.state.tools.push({
          id: message.toolCallId,
          name: message.toolName ?? "tool",
          args: isObject(calls.get(message.toolCallId)?.arguments)
            ? calls.get(message.toolCallId)!.arguments
            : {},
          result: { content: message.content, details: message.details },
          status: message.isError ? "error" : "success",
        });
    this.emit(["messages", "tools", "generation"]);
  }
  apply(record: PiRecord): void {
    const state = this.state;
    let changed: (keyof ViewState)[];
    switch (record.type) {
      case "agent_start":
        state.run = "running";
        state.runStartedAt ??= Date.now();
        state.generation = undefined;
        changed = ["run", "runStartedAt", "generation"];
        break;
      case "agent_settled":
        state.run = "idle";
        state.runStartedAt = undefined;
        state.generation = undefined;
        state.retry = { ...state.retry, active: false };
        changed = ["run", "retry", "runStartedAt", "generation"];
        break;
      case "message_start":
        if (!validMessage(record.message)) return;
        this.activeMessage = state.messages.length;
        state.messages.push(structuredClone(record.message));
        state.generation = undefined;
        changed = ["messages", "generation"];
        break;
      case "message_update": {
        const event = record.assistantMessageEvent;
        if (
          !isObject(event) ||
          typeof event.type !== "string" ||
          !Number.isInteger(event.contentIndex) ||
          event.contentIndex < 0 ||
          event.contentIndex > 10000
        )
          return;
        if (this.activeMessage === undefined) {
          this.activeMessage = state.messages.length;
          state.messages.push({ role: "assistant", content: [] });
        }
        const message = state.messages[this.activeMessage];
        if (message.role !== "assistant") return;
        if (!Array.isArray(message.content)) message.content = [];
        const index = event.contentIndex;
        if (event.type.startsWith("text_")) {
          const old = message.content[index];
          message.content[index] = {
            type: "text",
            text:
              event.type === "text_end"
                ? event.content
                : (old?.text ?? "") + (event.delta ?? ""),
          };
        } else if (event.type.startsWith("thinking_")) {
          const old = message.content[index];
          message.content[index] = {
            type: "thinking",
            thinking:
              event.type === "thinking_end"
                ? event.content
                : (old?.thinking ?? "") + (event.delta ?? ""),
          };
        } else if (event.type === "toolcall_start")
          message.content[index] = {
            type: "toolCall",
            id: event.id,
            name: event.toolName,
            arguments: {},
          };
        else if (event.type === "toolcall_end" && isObject(event.toolCall))
          message.content[index] = event.toolCall;
        if (record.usage) message.usage = record.usage;
        const kind = event.type.startsWith("thinking_")
          ? "thinking"
          : event.type.startsWith("text_")
            ? "text"
            : event.type.startsWith("toolcall_")
              ? "toolCall"
              : undefined;
        if (kind) {
          // End events finish a phase, not the run. Only agent_settled is idle.
          state.generation = event.type.endsWith("_end")
            ? undefined
            : { kind, messageIndex: this.activeMessage, contentIndex: index };
        }
        changed = ["messages", "generation"];
        break;
      }
      case "message_end":
        if (!validMessage(record.message)) return;
        if (this.activeMessage !== undefined)
          state.messages[this.activeMessage] = structuredClone(record.message);
        else state.messages.push(structuredClone(record.message));
        this.activeMessage = undefined;
        state.generation = undefined;
        changed = ["messages", "generation"];
        break;
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end": {
        if (
          typeof record.toolCallId !== "string" ||
          typeof record.toolName !== "string"
        )
          return;
        let tool = state.tools.find((tool) => tool.id === record.toolCallId);
        if (!tool) {
          tool = {
            id: record.toolCallId,
            name: record.toolName,
            args: isObject(record.args) ? record.args : {},
            status: "pending",
          };
          state.tools.push(tool);
        }
        if (isObject(record.partialResult)) tool.result = record.partialResult;
        if (record.type === "tool_execution_end") {
          tool.result = isObject(record.result) ? record.result : {};
          tool.status = record.isError ? "error" : "success";
          tool.durationMs = record.durationMs;
        }
        changed = ["tools"];
        break;
      }
      case "queue_update":
        if (strings(record.steering) && strings(record.followUp))
          state.queues = {
            steering: record.steering,
            followUp: record.followUp,
          };
        else return;
        changed = ["queues"];
        break;
      case "session_info_changed":
        if (!state.session) return;
        state.session.name =
          typeof record.name === "string" ? record.name : undefined;
        changed = ["session"];
        break;
      case "thinking_level_changed":
        state.thinkingLevel = record.level;
        changed = ["thinkingLevel"];
        break;
      case "auto_retry_start":
      case "summarization_retry_scheduled":
      case "summarization_retry_attempt_start":
        state.run = "running";
        state.runStartedAt ??= Date.now();
        state.generation = undefined;
        state.retry = { ...state.retry, ...record, active: true };
        changed = ["run", "retry", "runStartedAt", "generation"];
        break;
      case "auto_retry_end":
      case "summarization_retry_finished":
        state.retry = { ...state.retry, ...record, active: false };
        changed = ["retry"];
        break;
      case "compaction_start":
        state.compaction = {
          ...state.compaction,
          active: true,
          reason: record.reason,
          error: undefined,
          notice: undefined,
        };
        changed = ["compaction"];
        break;
      case "compaction_end":
        state.compaction = {
          ...state.compaction,
          active: false,
          result: record.result,
          error: record.errorMessage,
          aborted: record.aborted,
        };
        if (record.willRetry) state.run = "running";
        changed = record.willRetry ? ["compaction", "run"] : ["compaction"];
        break;
      case "extension_error":
        state.error = String(record.error ?? "PI extension error");
        changed = ["error"];
        break;
      default:
        return;
    }
    this.emit(changed);
  }
  private emit(changed: readonly (keyof ViewState)[]): void {
    if (!changed.length) return;
    const listeners = [...this.listeners].filter(
      ([, keys]) => !keys || keys.some((key) => changed.includes(key)),
    );
    if (listeners.length) {
      const snapshot = this.getSnapshot();
      for (const [listener] of listeners) listener(snapshot);
    }
    // Publish after synchronous subscribers have derived queue controls.
    for (const listener of this.changeListeners) listener(changed);
  }
}
function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
function validMessage(value: unknown): value is AgentMessage {
  return (
    isObject(value) &&
    typeof value.role === "string" &&
    (typeof value.content === "string" || Array.isArray(value.content))
  );
}
