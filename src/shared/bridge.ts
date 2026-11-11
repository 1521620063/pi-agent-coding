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
  pendingUi: JsonObject[];
  attachments: Attachment[];
  models: Model[];
  model?: Model;
  thinkingLevel?: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
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
export type ClientAction =
  | {
      type:
        | "ready"
        | "connect"
        | "disconnect"
        | "stop"
        | "attachFiles"
        | "attachSelection"
        | "chooseModel"
        | "chooseThinking"
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
  | { type: "image"; data: string; mimeType: string; name: string }
  | { type: "autoCompaction" | "autoRetry"; enabled: boolean }
  | { type: "shell"; command: string; excludeFromContext: boolean }
  | { type: "openLink"; url: string };
export type HostMessage =
  | { type: "snapshot"; state: ViewState }
  | { type: "sent"; attachmentIds: string[] };
export function snapshotMessage(state: ViewState): HostMessage {
  return { type: "snapshot", state };
}
const simple = new Set([
  "ready",
  "connect",
  "disconnect",
  "stop",
  "attachFiles",
  "attachSelection",
  "chooseModel",
  "chooseThinking",
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
  if (simple.has(value.type))
    return keys.length === 1 ? (value as ClientAction) : undefined;
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
