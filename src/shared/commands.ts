// Sidebar shortcuts for operations already exposed through PI RPC.
// Keep these separate from PI's discovered skills, prompts and extensions.
export const builtinCommands = [
  { name: "new", description: "新建会话", action: "newSession" },
  {
    name: "compact",
    description: "压缩上下文（可附加摘要要求）",
    action: "compact",
  },
  {
    name: "model",
    description: "选择 PI 模型",
    action: "chooseModel",
    control: "model",
  },
  {
    name: "thinking",
    description: "选择思考强度",
    action: "chooseThinking",
    control: "thinking",
  },
  {
    name: "resume",
    description: "打开工作区会话历史",
    action: "openSession",
    control: "history",
  },
  {
    name: "name",
    description: "重命名当前会话（可附加名称）",
    action: "renameSession",
  },
  { name: "fork", description: "选择消息分叉（不回滚文件）", action: "fork" },
  { name: "clone", description: "复制当前会话（不回滚文件）", action: "clone" },
  { name: "tree", description: "只读浏览历史树", action: "tree" },
  { name: "export", description: "导出对话为 HTML", action: "export" },
  {
    name: "settings",
    description: "打开侧栏设置",
    action: "settings",
    control: "settings",
  },
  { name: "stop", description: "清空队列并停止当前任务", action: "stop" },
] as const;

export function parseBuiltinCommand(
  text: string,
  discovered: readonly { name: string }[] = [],
) {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return;
  if (discovered.some((command) => command.name === match[1])) return;
  const command = builtinCommands.find((item) => item.name === match[1]);
  if (command) return { ...command, args: match[2]?.trim() ?? "" };
}
