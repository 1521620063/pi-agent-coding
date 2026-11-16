import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import type { ResourceScope } from "../shared/resources";

export type ConfigObject = Record<string, unknown>;
export const isRecord = (value: unknown): value is ConfigObject =>
  !!value && typeof value === "object" && !Array.isArray(value);
export interface ResourceConfig {
  path: string;
  text: string;
  value: ConfigObject;
}
export function agentDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_CODING_AGENT_DIR;
  return override
    ? path.resolve(expandHome(override))
    : path.join(homedir(), ".pi", "agent");
}
export function expandHome(value: string): string {
  return value === "~"
    ? homedir()
    : /^~[/\\]/.test(value)
      ? path.join(homedir(), value.slice(2))
      : value;
}
export function configPath(
  workspace: string,
  agentDir: string,
  scope: ResourceScope,
  mcp = false,
): string {
  return path.join(
    scope === "project" ? path.join(workspace, ".pi") : agentDir,
    mcp ? "mcp.json" : "settings.json",
  );
}
export async function readResourceConfig(
  file: string,
): Promise<ResourceConfig> {
  let text: string;
  try {
    if ((await stat(file)).size > 1_048_576)
      throw new Error("插件配置读取限制：文件超过 1 MiB");
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path: file, text: "", value: {} };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${file}：JSON 无效，请在编辑器修复后刷新。`);
  }
  if (!isRecord(value)) throw new Error(`${file}：配置根节点必须是对象。`);
  return { path: file, text, value };
}
/** Changes one JSON property, preserving unrelated text, unknown fields and line endings. */
export function patchResourceConfig(
  config: ResourceConfig,
  keys: (string | number)[],
  value: unknown,
): string {
  const text = config.text || "{}\n";
  const indent = /^([\t ]+)\S/m.exec(text)?.[1] ?? "  ";
  return applyEdits(
    text,
    modify(text, keys, value, {
      formattingOptions: {
        insertSpaces: !indent.includes("\t"),
        tabSize: indent.length,
        eol: text.includes("\r\n") ? "\r\n" : "\n",
      },
    }),
  );
}
export function resourcePaths(
  config: ResourceConfig,
  kind: "skills" | "extensions",
): string[] {
  const values = config.value[kind];
  if (values === undefined) return [];
  if (
    !Array.isArray(values) ||
    !values.every((value) => typeof value === "string")
  )
    throw new Error(`${config.path}：${kind} 必须是字符串数组。`);
  return values;
}
export function resolveResourcePath(
  value: string,
  config: ResourceConfig,
): string {
  return path.resolve(path.dirname(config.path), expandHome(value));
}
export function packageCliSource(
  source: string,
  config: ResourceConfig,
): string {
  return /^(?:npm:|git:|https?:\/\/|ssh:\/\/)/i.test(source)
    ? source
    : resolveResourcePath(source, config);
}
function matchesExactResource(
  raw: string,
  config: ResourceConfig,
  kind: "skills" | "extensions",
  target: string,
): boolean {
  if (raw.startsWith("builtin:")) return raw === target;
  const resolved = resolveResourcePath(raw, config);
  return (
    resolved === target ||
    (kind === "skills" &&
      path.basename(target) === "SKILL.md" &&
      resolved === path.dirname(target))
  );
}
export function exactResourceRule(
  config: ResourceConfig,
  kind: "skills" | "extensions",
  target: string,
  enabled: boolean,
): string[] {
  const values = resourcePaths(config, kind).filter((entry) => {
    if (!/^[+-]/.test(entry)) return true;
    return !matchesExactResource(entry.slice(1), config, kind, target);
  });
  return [...values, `${enabled ? "+" : "-"}${target}`];
}
export function exactRuleState(
  config: ResourceConfig,
  kind: "skills" | "extensions",
  target: string,
  scope: ResourceScope = "user",
): boolean | undefined {
  let result: boolean | undefined;
  for (const entry of resourcePaths(config, kind)) {
    if (
      /^[+-]/.test(entry) &&
      matchesExactResource(entry.slice(1), config, kind, target)
    ) {
      // Project built-ins use an ordered override delta. Other local resources
      // apply exact exclusions after inclusions, regardless of order.
      if (scope === "project" && target.startsWith("builtin:"))
        result = entry.startsWith("+");
      else {
        if (entry.startsWith("-")) return false;
        result = true;
      }
    }
  }
  return result;
}
export interface LocalResource {
  path: string;
  name: string;
}
/** Bounded local discovery, not a replacement for PI's resource loader. */
export async function discoverLocalResources(
  roots: string[],
  kind: "skills" | "extensions",
): Promise<{ items: LocalResource[]; truncated: boolean; warnings: string[] }> {
  const items = new Map<string, LocalResource>();
  const warnings: string[] = [];
  let remaining = 1500;
  let truncated = false;
  const visited = new Set<string>();
  const visitEntry = async (
    file: string,
    depth: number,
    explicit = false,
  ): Promise<void> => {
    if (visited.has(file)) return;
    visited.add(file);
    if (--remaining < 0 || depth > 10 || items.size >= 300) {
      truncated = true;
      return;
    }
    let info;
    try {
      info = await stat(file);
    } catch (error) {
      if (
        ["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return;
      throw error;
    }
    if (info.isFile()) {
      if (
        kind === "skills"
          ? path.basename(file) === "SKILL.md" ||
            (explicit && /\.md$/i.test(file))
          : (explicit ? /\.(?:[cm]?js|ts)$/i : /\.(?:js|ts)$/i).test(file)
      )
        items.set(file, {
          path: file,
          name:
            kind === "skills" && path.basename(file) === "SKILL.md"
              ? path.basename(path.dirname(file))
              : path.basename(file),
        });
      return;
    }
    if (!info.isDirectory()) return;
    const children = await readdir(file, { withFileTypes: true });
    if (kind === "skills") {
      const skill = children.find(
        (entry) => entry.name === "SKILL.md" && entry.isFile(),
      );
      if (skill) {
        await visit(path.join(file, skill.name), depth + 1);
        return;
      }
    }
    if (kind === "extensions") {
      // PI resolves a directory's manifest before falling back to index files.
      if (
        children.some(
          (entry) => entry.name === "package.json" && entry.isFile(),
        )
      ) {
        const manifestPath = path.join(file, "package.json");
        const manifest = await readResourceConfig(manifestPath).catch(() => {
          warnings.push(`${manifestPath}：扩展清单无法读取或 JSON 无效。`);
          return undefined;
        });
        if (
          manifest &&
          isRecord(manifest.value.pi) &&
          Array.isArray(manifest.value.pi.extensions) &&
          manifest.value.pi.extensions.length
        ) {
          items.set(manifestPath, {
            path: manifestPath,
            name: path.basename(file),
          });
          return;
        }
      }
      for (const name of ["index.ts", "index.js"]) {
        if (children.some((entry) => entry.name === name && entry.isFile())) {
          await visit(path.join(file, name), depth + 1);
          return;
        }
      }
      if (depth > 0 || (explicit && path.basename(file) !== "extensions"))
        return;
    }
    for (const entry of children) {
      if (remaining < 0 || items.size >= 300) {
        truncated = true;
        break;
      }
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.isSymbolicLink()
      )
        continue;
      await visit(path.join(file, entry.name), depth + 1);
    }
  };
  const visit = async (file: string, depth: number, explicit = false) => {
    try {
      await visitEntry(file, depth, explicit);
    } catch {
      warnings.push(`${file}：资源无法读取。`);
    }
  };
  for (const root of roots) await visit(root, 0, true);
  return { items: [...items.values()], truncated, warnings };
}
export async function agentSkillRoots(workspace: string): Promise<string[]> {
  const roots = [path.join(homedir(), ".agents", "skills")];
  let current = workspace;
  while (true) {
    roots.push(path.join(current, ".agents", "skills"));
    try {
      await stat(path.join(current, ".git"));
      break;
    } catch {
      /* Continue through ancestors, as PI does. */
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}
export function validatePackageSource(value: string): string | undefined {
  if (["self", "pi"].includes(value))
    return "这是 PI 自身更新的保留名称，请使用明确的 npm:、git: 或本地路径来源。";
  if (
    !value.trim() ||
    value !== value.trim() ||
    value.length > 4096 ||
    /^-/.test(value) ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    return "请输入 npm:、git:、仓库 URL 或本地路径，不能以 - 开头或包含控制字符。";
  return;
}
export function validateMcpName(value: string): string | undefined {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
    !["__proto__", "prototype", "constructor"].includes(value)
    ? undefined
    : "名称限 1–128 个字母、数字、下划线或连字符。";
}
