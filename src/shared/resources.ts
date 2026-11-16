export type ResourceScope = "user" | "project";
export type ResourceKind = "mcp" | "skills" | "extensions" | "packages";
export const resourceOperations = [
  "refresh",
  "openConfig",
  "addMcp",
  "addPath",
  "createSkill",
  "install",
  "configure",
  "diagnose",
  "listPackages",
  "updateAll",
  "apply",
  "open",
  "edit",
  "toggle",
  "exposure",
  "remove",
  "filters",
  "update",
  "login",
  "projectOverride",
  "logout",
] as const;
export type ResourceOperation = (typeof resourceOperations)[number];
export interface ResourceAction {
  type: "resourceAction";
  operation: ResourceOperation;
  scope: ResourceScope;
  kind: ResourceKind;
  id?: string;
}
export interface ResourceItem {
  id: string;
  kind: ResourceKind;
  scope: ResourceScope;
  name: string;
  detail: string;
  path?: string;
  state: string;
  actions: ResourceOperation[];
}
export interface ResourceSnapshot {
  workspace: string;
  agentDir: string;
  items: ResourceItem[];
  warnings: string[];
  busy: boolean;
  pending: boolean;
  canApply: boolean;
  notice?: string;
  error?: string;
}
export function parseResourceAction(
  value: Record<string, unknown>,
): ResourceAction | undefined {
  if (
    value.type !== "resourceAction" ||
    !Object.keys(value).every((key) =>
      ["type", "operation", "scope", "kind", "id"].includes(key),
    ) ||
    !resourceOperations.includes(value.operation as ResourceOperation) ||
    typeof value.scope !== "string" ||
    !["user", "project"].includes(value.scope) ||
    typeof value.kind !== "string" ||
    !["mcp", "skills", "extensions", "packages"].includes(value.kind) ||
    (value.id !== undefined &&
      (typeof value.id !== "string" || !/^[a-f0-9-]{1,80}$/.test(value.id)))
  )
    return;
  return value as unknown as ResourceAction;
}
