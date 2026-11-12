import {
  isObject,
  type AgentMessage,
  type Model,
  type SlashCommand,
  type SessionStats,
  type ThinkingLevel,
  type JsonObject,
} from "../pi/protocol";
export type Unsubscribe = () => void;
export interface Attachment {
  id: string;
  name: string;
  kind: "text" | "image";
  size: number;
  preview: string;
  reference?: string;
}
export interface ContextFile {
  id: string;
  label: string;
  description?: string;
  source: "workspace" | "open" | "current";
}
export interface ToolView {
  id: string;
  name: string;
  args: JsonObject;
  result?: JsonObject;
  status: "pending" | "success" | "error";
  durationMs?: number;
}
export interface ViewState {
  connection: "disconnected" | "connecting" | "connected" | "error";
  error?: string;
  workspace?: string;
  session?: { id: string; path?: string; name?: string };
  run: "idle" | "running";
  messages: AgentMessage[];
  tools: ToolView[];
  queues: { steering: string[]; followUp: string[] };
  queueControl?: {
    revision: number;
    busy: boolean;
    canSteer: boolean;
    reason?: string;
  };
  queueModes?: {
    steering?: "all" | "one-at-a-time";
    followUp?: "all" | "one-at-a-time";
  };
  pendingUi: JsonObject[];
  attachments: Attachment[];
  models: Model[];
  model?: Model;
  thinkingLevel?: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  sessions?: SessionSummary[];
  commands: SlashCommand[];
  stats?: SessionStats;
  compaction: JsonObject;
  retry: JsonObject;
  statuses: Record<string, string>;
  widgets: Record<string, { lines: string[]; placement: string }>;
  editorText?: { text: string; revision: number; append?: boolean };
  title?: string;
  shell?: JsonObject;
}
export interface SessionSummary {
  sessionPath: string;
  sessionId: string;
  name?: string;
  lastOpenedAt: string;
}
export type ClientAction =
  | {
      type:
        | "ready"
        | "connect"
        | "disconnect"
        | "stop"
        | "attachFiles"
        | "attachSelection"
        | "refreshModels"
        | "sessions"
        | "newSession"
        | "openSession"
        | "renameSession"
        | "compact"
        | "clearQueue"
        | "cancelRetry"
        | "fork"
        | "clone"
        | "tree"
        | "export"
        | "cancelShell"
        | "settings";
    }
  | {
      type: "send";
      text: string;
      attachmentIds: string[];
      mode: "steer" | "followUp";
    }
  | { type: "removeAttachment"; id: string }
  | { type: "chooseModel"; provider: string; modelId: string }
  | { type: "chooseThinking"; level: ThinkingLevel }
  | { type: "selectSession" | "removeSession"; sessionPath: string }
  | { type: "image"; data: string; mimeType: string; name: string }
  | { type: "autoCompaction" | "autoRetry"; enabled: boolean }
  | { type: "shell"; command: string; excludeFromContext: boolean }
  | { type: "searchFiles"; query: string; requestId: number }
  | { type: "attachContext"; id: string }
  | { type: "openFile"; reference: string }
  | {
      type:
        | "attachDiagnostics"
        | "touchedFiles"
        | "openScm"
        | "searchConversation"
        | "showCommands"
        | "cycleModel"
        | "cycleThinking";
    }
  | { type: "forkMessage"; index: number }
  | { type: "promoteQueued"; index: number; revision: number }
  | { type: "copyText"; text: string }
  | { type: "openCode"; text: string; language: string }
  | {
      type: "queueMode";
      channel: "steering" | "followUp";
      mode: "all" | "one-at-a-time";
    }
  | { type: "openLink"; url: string };
export type HostMessage =
  | { type: "snapshot"; state: ViewState }
  | { type: "contextAttached"; id: string; success: boolean }
  | {
      type: "fileCandidates";
      requestId: number;
      items: ContextFile[];
      truncated: boolean;
      error?: string;
    }
  | { type: "sent"; attachmentIds: string[] };
export function snapshotMessage(state: ViewState): HostMessage {
  return { type: "snapshot", state };
}
const simple = new Set([
  "attachDiagnostics",
  "touchedFiles",
  "openScm",
  "searchConversation",
  "showCommands",
  "cycleModel",
  "cycleThinking",
  "ready",
  "connect",
  "disconnect",
  "stop",
  "attachFiles",
  "attachSelection",
  "refreshModels",
  "sessions",
  "newSession",
  "openSession",
  "renameSession",
  "compact",
  "clearQueue",
  "cancelRetry",
  "fork",
  "clone",
  "tree",
  "export",
  "cancelShell",
  "settings",
]);
export function parseClientAction(value: unknown): ClientAction | undefined {
  if (!isObject(value) || typeof value.type !== "string") return;
  const keys = Object.keys(value);
  if (
    value.type === "promoteQueued" &&
    keys.length === 3 &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0 &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0
  )
    return value as ClientAction;
  if (
    value.type === "forkMessage" &&
    keys.length === 2 &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0
  )
    return value as ClientAction;
  if (
    value.type === "copyText" &&
    keys.length === 2 &&
    typeof value.text === "string" &&
    value.text.length <= 2_000_000
  )
    return value as ClientAction;
  if (
    value.type === "openCode" &&
    keys.length === 3 &&
    typeof value.text === "string" &&
    value.text.length <= 2_000_000 &&
    typeof value.language === "string" &&
    /^[\w+-]{0,80}$/.test(value.language)
  )
    return value as ClientAction;
  if (
    value.type === "queueMode" &&
    keys.length === 3 &&
    ["steering", "followUp"].includes(value.channel) &&
    ["all", "one-at-a-time"].includes(value.mode)
  )
    return value as ClientAction;
  if (
    value.type === "searchFiles" &&
    keys.length === 3 &&
    typeof value.query === "string" &&
    value.query.length <= 2000 &&
    Number.isSafeInteger(value.requestId) &&
    value.requestId >= 0
  )
    return value as ClientAction;
  if (
    value.type === "attachContext" &&
    keys.length === 2 &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 200
  )
    return value as ClientAction;
  if (
    value.type === "openFile" &&
    keys.length === 2 &&
    typeof value.reference === "string" &&
    value.reference.length > 0 &&
    value.reference.length <= 32768 &&
    !/[\u0000-\u001f]/.test(value.reference) &&
    !/^(?:command|javascript|data|file|https?|vscode):/i.test(
      value.reference,
    ) &&
    (!/^(?![A-Za-z]:[\\/])[A-Za-z][\w+.-]*:/.test(value.reference) ||
      value.reference.startsWith("untitled:") ||
      /^[^:/\\]+:\d+(?::\d+)?$/.test(value.reference))
  )
    return value as ClientAction;
  if (simple.has(value.type))
    return keys.length === 1 ? (value as ClientAction) : undefined;
  if (
    value.type === "chooseModel" &&
    keys.length === 3 &&
    typeof value.provider === "string" &&
    value.provider.length > 0 &&
    value.provider.length <= 1000 &&
    typeof value.modelId === "string" &&
    value.modelId.length > 0 &&
    value.modelId.length <= 1000
  )
    return value as ClientAction;
  if (
    value.type === "chooseThinking" &&
    keys.length === 2 &&
    ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value.level)
  )
    return value as ClientAction;
  if (
    ["selectSession", "removeSession"].includes(value.type) &&
    keys.length === 2 &&
    typeof value.sessionPath === "string" &&
    value.sessionPath.length > 0 &&
    value.sessionPath.length <= 32768
  )
    return value as ClientAction;
  if (
    value.type === "send" &&
    keys.every((k) => ["type", "text", "attachmentIds", "mode"].includes(k)) &&
    typeof value.text === "string" &&
    value.text.length <= 2_000_000 &&
    Array.isArray(value.attachmentIds) &&
    value.attachmentIds.length <= 100 &&
    value.attachmentIds.every((id: unknown) => typeof id === "string") &&
    ["steer", "followUp"].includes(value.mode)
  )
    return value as ClientAction;
  if (
    value.type === "removeAttachment" &&
    keys.length === 2 &&
    typeof value.id === "string"
  )
    return value as ClientAction;
  if (
    value.type === "image" &&
    keys.every((k) => ["type", "data", "mimeType", "name"].includes(k)) &&
    typeof value.data === "string" &&
    value.data.length <= 7_000_000 &&
    typeof value.mimeType === "string" &&
    typeof value.name === "string"
  )
    return value as ClientAction;
  if (
    ["autoCompaction", "autoRetry"].includes(value.type) &&
    keys.length === 2 &&
    typeof value.enabled === "boolean"
  )
    return value as ClientAction;
  if (
    value.type === "shell" &&
    keys.length === 3 &&
    typeof value.command === "string" &&
    value.command.length <= 100000 &&
    typeof value.excludeFromContext === "boolean"
  )
    return value as ClientAction;
  if (
    value.type === "openLink" &&
    keys.length === 2 &&
    typeof value.url === "string" &&
    /^https?:\/\//i.test(value.url)
  )
    return value as ClientAction;
}
