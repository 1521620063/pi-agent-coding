import { constants } from "node:fs";
import {
  access,
  open,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
  resolve,
  win32,
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
      "未找到本机 PI。已检查 PATH 和常见安装目录；若 VS Code 加载 shell 环境失败，请在用户设置中配置 pi.executablePath 后重新连接。",
    );
    this.name = "PiNotFoundError";
  }
}
async function exists(path: string, executable = false) {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(
      path,
      executable && process.platform !== "win32"
        ? constants.X_OK
        : constants.F_OK,
    );
    return true;
  } catch {
    return false;
  }
}
async function header(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
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
const packages = [
  "@earendil-works/pi-coding-agent",
  "@mariozechner/pi-coding-agent",
];
async function packageEntry(base: string): Promise<string | undefined> {
  for (const name of packages) {
    const directory = join(base, "node_modules", name);
    try {
      const pkg: unknown = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      );
      if (!pkg || typeof pkg !== "object" || !("bin" in pkg)) continue;
      const bin =
        typeof pkg.bin === "string"
          ? pkg.bin
          : pkg.bin && typeof pkg.bin === "object" && "pi" in pkg.bin
            ? pkg.bin.pi
            : undefined;
      if (typeof bin !== "string") continue;
      const entry = resolve(directory, bin);
      if (await exists(entry)) return entry;
    } catch {
      /* Try the next supported npm package. */
    }
  }
}
/** No shell evaluation: discovery uses only known install locations and the supplied environment. */
export function installationDirectories(
  env: NodeJS.ProcessEnv,
  platform = process.platform,
): string[] {
  // Use the requested platform's path rules, including when validating another
  // platform's discovery rules in tests.
  const { join } = platform === "win32" ? win32 : posix;
  const value = (name: string): string | undefined => {
    if (platform !== "win32") return env[name];
    const key = Object.keys(env)
      .sort()
      .find((key) => key.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : env[key];
  };
  const home =
    (platform === "win32"
      ? value("USERPROFILE") || value("HOME")
      : value("HOME") || value("USERPROFILE")) || homedir();
  const directories = [
    join(home, ".local", "bin"),
    join(home, ".pi", "agent", "bin"),
  ];
  if (platform === "win32") {
    const appData = value("APPDATA");
    const localAppData = value("LOCALAPPDATA");
    const programFiles = value("ProgramFiles");
    const nvmSymlink = value("NVM_SYMLINK");
    if (appData) directories.push(join(appData, "npm"));
    if (localAppData)
      directories.push(
        join(localAppData, "Volta", "bin"),
        join(localAppData, "Programs", "nodejs"),
      );
    if (programFiles)
      directories.push(
        join(programFiles, "nodejs"),
        join(programFiles, "Volta"),
      );
    if (nvmSymlink) directories.push(nvmSymlink);
  } else {
    if (env.NVM_BIN) directories.push(env.NVM_BIN);
    directories.push(
      join(home, ".volta", "bin"),
      join(home, ".npm-global", "bin"),
      join(home, ".n", "bin"),
      join(home, ".local", "share", "fnm", "aliases", "default", "bin"),
      join(home, ".fnm", "aliases", "default", "bin"),
    );
    if (env.XDG_DATA_HOME)
      directories.push(join(env.XDG_DATA_HOME, "pi-node", "current", "bin"));
    directories.push(
      join(home, ".local", "share", "pi-node", "current", "bin"),
    );
    if (platform === "darwin")
      directories.push("/opt/homebrew/bin", "/usr/local/bin");
  }
  const voltaHome = value("VOLTA_HOME");
  if (voltaHome) directories.unshift(join(voltaHome, "bin"));
  const npmPrefix = value("npm_config_prefix");
  if (npmPrefix)
    directories.push(platform === "win32" ? npmPrefix : join(npmPrefix, "bin"));
  return directories;
}
async function nvmDirectories(env: NodeJS.ProcessEnv): Promise<string[]> {
  if (process.platform === "win32") return [];
  const root = env.NVM_DIR || join(env.HOME || homedir(), ".nvm");
  try {
    // Respect the selected default; do not pick an arbitrary installed version.
    let alias = (await readFile(join(root, "alias", "default"), "utf8")).trim();
    if (/^lts\/[A-Za-z*]+$/.test(alias))
      alias = (await readFile(join(root, "alias", alias), "utf8")).trim();
    if (!/^v?\d+(?:\.\d+){0,2}$/.test(alias)) return [];
    const prefix = alias.replace(/^v/, "").split(".");
    const versions = (await readdir(join(root, "versions", "node")))
      .filter(
        (name) =>
          /^v\d+\.\d+\.\d+$/.test(name) &&
          prefix.every((part, i) => name.slice(1).split(".")[i] === part),
      )
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    return versions.length
      ? [join(root, "versions", "node", versions.at(-1)!, "bin")]
      : [];
  } catch {
    return [];
  }
}
async function findIn(directories: string[], names: string[]) {
  for (const directory of directories)
    for (const name of names) {
      const path = join(directory, name);
      if (await exists(path, !/\.(?:cmd|ps1|bat)$/i.test(name))) return path;
    }
}
export async function resolvePiLaunch(
  config: LaunchConfig,
  sourceEnv: NodeJS.ProcessEnv,
): Promise<LaunchSpec> {
  const env = { ...sourceEnv };
  const pathKeys = Object.keys(env).filter((key) =>
    process.platform === "win32"
      ? key.toLowerCase() === "path"
      : key === "PATH",
  );
  // Match Node's Windows spawn semantics when a plain object contains both
  // PATH and Path: the first key in lexicographic order takes precedence.
  const pathKey =
    (process.platform === "win32" ? pathKeys.sort()[0] : pathKeys.at(-1)) ??
    "PATH";
  for (const key of pathKeys) if (key !== pathKey) delete env[key];
  const inherited = (env[pathKey] ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => directory.replace(/^"|"$/g, ""));
  if (config.nodePath && !isAbsolute(config.nodePath))
    throw new Error("pi.nodePath 必须是 Node.js 可执行文件的绝对路径。");
  if (config.nodePath && !(await exists(config.nodePath, true)))
    throw new Error("配置的 Node.js 不存在或不可执行，请检查 pi.nodePath。");
  const directories = [
    ...new Set([
      ...inherited,
      ...(config.nodePath ? [dirname(config.nodePath)] : []),
      ...installationDirectories(env),
      ...(await nvmDirectories(env)),
    ]),
  ];
  let executable = config.executablePath;
  if (executable && !isAbsolute(executable))
    throw new Error("PI executablePath must be an absolute path.");
  if (!executable)
    executable = await findIn(
      directories,
      process.platform === "win32"
        ? ["pi.exe", "pi.cmd", "pi.ps1", "pi"]
        : ["pi"],
    );
  if (!executable || !(await exists(executable))) throw new PiNotFoundError();
  const target = await realpath(executable);
  const extension = extname(target).toLowerCase();
  let entry: string | undefined;
  if ([".js", ".mjs", ".cjs"].includes(extension)) entry = target;
  else if ([".cmd", ".bat", ".ps1"].includes(extension)) {
    const official = join(dirname(target), "pi-launcher.js");
    entry = (await exists(official))
      ? official
      : await packageEntry(dirname(target));
    if (!entry)
      throw new Error(
        "无法识别 PI 启动器。请将 pi.executablePath 配置为官方 JavaScript 入口或可执行文件。",
      );
  }
  // The managed POSIX installer selects its release using this marker. Resolve
  // its package entry rather than executing or parsing arbitrary shell commands.
  if (
    !entry &&
    dirname(target).endsWith(`${process.platform === "win32" ? "\\" : "/"}bin`)
  ) {
    const root = join(dirname(target), "..", "install");
    try {
      const script = await header(target);
      if (
        script.startsWith("#!/bin/sh") &&
        script.includes("PI_MANAGED_INSTALL_ROOT") &&
        script.includes("install/current-version")
      ) {
        const version = (
          await readFile(join(root, "current-version"), "utf8")
        ).trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version))
          throw new Error("PI 安装版本标记无效。");
        entry = await packageEntry(join(root, "releases", version));
        if (!entry)
          throw new Error(
            "PI 官方安装不完整：当前版本入口缺失，请修复 PI 安装。",
          );
        env.PI_MANAGED_INSTALL_ROOT = resolve(root);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("PI "))
        throw error;
    }
  }
  const nodeDirectories = [
    ...new Set([
      ...inherited,
      dirname(executable),
      dirname(target),
      ...directories,
    ]),
  ];
  const node =
    config.nodePath ||
    (await findIn(
      nodeDirectories,
      process.platform === "win32" ? ["node.exe"] : ["node"],
    ));
  // Include fallback directories for tools started by PI as well as its shebang.
  env[pathKey] = [
    ...new Set([
      ...(node ? [dirname(node)] : []),
      dirname(executable),
      ...directories,
    ]),
  ].join(delimiter);
  if (entry) {
    if (!node)
      throw new Error(
        "已找到 PI，但未找到 Node.js。请安装 Node.js 或在用户设置中配置 pi.nodePath。",
      );
    return { command: node, args: [entry], env };
  }
  if (process.platform !== "win32") {
    const firstLine = await header(target);
    if (/^#!.*\b(?:ba|z|fi|k)?sh\b/.test(firstLine))
      throw new Error(
        "无法识别 PI shell 启动器。请将 pi.executablePath 配置为官方 JavaScript 入口或可执行文件。",
      );
    if (/^#!.*\bnode\b/.test(firstLine) && !node)
      throw new Error("已找到 PI，但未找到 Node.js。请配置 pi.nodePath。");
    if (!(await exists(target, true)))
      throw new Error(
        "PI 文件不可执行，请检查安装文件权限或 pi.executablePath。",
      );
  }
  return { command: executable, args: [], env };
}
