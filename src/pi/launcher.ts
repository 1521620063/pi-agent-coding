import { access, readFile } from "node:fs/promises";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
export interface LaunchSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}
export interface LaunchConfig {
  executablePath?: string;
  nodePath?: string;
}
export class PiNotFoundError extends Error {
  constructor() {
    super(
      "未找到本机 PI。请按官方说明安装 PI，安装后重启 VS Code；若已安装，请在用户设置中配置 pi.executablePath 后重新连接。",
    );
    this.name = "PiNotFoundError";
  }
}
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
export function assertWorkspace(context: {
  trusted: boolean;
  uri?: string;
  remote?: boolean;
}): string {
  if (!context.trusted)
    throw new Error("Trust this workspace in VS Code before starting PI.");
  if (!context.uri)
    throw new Error("Open a local workspace folder before starting PI.");
  if (context.remote || new URL(context.uri).protocol !== "file:")
    throw new Error("Only local workspaces are supported by this release.");
  return fileURLToPath(context.uri);
}
export async function resolvePiLaunch(
  config: LaunchConfig,
  env: NodeJS.ProcessEnv,
): Promise<LaunchSpec> {
  const pathValue =
    Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ??
    "";
  const node = config.nodePath || "node";
  let executable = config.executablePath;
  if (executable && !isAbsolute(executable))
    throw new Error("PI executablePath must be an absolute path.");
  if (!executable) {
    for (const directory of pathValue.split(delimiter).filter(Boolean)) {
      for (const name of process.platform === "win32"
        ? ["pi.exe", "pi.cmd", "pi.ps1", "pi"]
        : ["pi"]) {
        const candidate = join(directory.replace(/^"|"$/g, ""), name);
        if (await exists(candidate)) {
          executable = candidate;
          break;
        }
      }
      if (executable) break;
    }
  }
  if (!executable || !(await exists(executable))) throw new PiNotFoundError();
  const extension = extname(executable).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(extension))
    return { command: node, args: [executable], env };
  if ([".cmd", ".bat", ".ps1"].includes(extension)) {
    const official = join(dirname(executable), "pi-launcher.js");
    if (await exists(official)) return { command: node, args: [official], env };
    // npm shims point at package.json bin. Never run a user-built shell string.
    for (const packageName of [
      "@earendil-works/pi-coding-agent",
      "@mariozechner/pi-coding-agent",
    ]) {
      const packageDir = join(dirname(executable), "node_modules", packageName);
      try {
        const pkg = JSON.parse(
          await readFile(join(packageDir, "package.json"), "utf8"),
        );
        const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
        if (typeof bin === "string" && (await exists(resolve(packageDir, bin))))
          return { command: node, args: [resolve(packageDir, bin)], env };
      } catch {
        /* try next supported package */
      }
    }
    throw new Error(
      "Unrecognized PI shell launcher. Set pi.executablePath to the official PI JavaScript launcher or executable.",
    );
  }
  return { command: executable, args: [], env };
}
