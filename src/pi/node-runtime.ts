import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { killTree } from "./process-tree";

// PI 1.5.2's declared runtime requirement, not the project's development Node version.
export const minimumPiNodeVersion = "22.19.0";

export function supportsPiNode(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return false;
  const [major, minor] = match.slice(1).map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}

/** Inspect only known version-manager layouts; never evaluate shell configuration. */
export async function managedNodeDirectories(
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const value = (name: string) => {
    const key =
      process.platform === "win32"
        ? Object.keys(env)
            .sort()
            .find((key) => key.toLowerCase() === name.toLowerCase())
        : name;
    return key ? env[key] : undefined;
  };
  const home =
    (process.platform === "win32"
      ? value("USERPROFILE") || value("HOME")
      : value("HOME") || value("USERPROFILE")) || homedir();
  const windows = process.platform === "win32";
  const roots: { directory: string; suffix: string[] }[] = [
    {
      directory: join(
        value("VOLTA_HOME") || join(home, ".volta"),
        "tools",
        "image",
        "node",
      ),
      suffix: windows ? [] : ["bin"],
    },
  ];
  if (windows) {
    if (value("NVM_HOME"))
      roots.push({ directory: value("NVM_HOME")!, suffix: [] });
    if (value("LOCALAPPDATA")) {
      roots.push({
        directory: join(
          value("LOCALAPPDATA")!,
          "Volta",
          "tools",
          "image",
          "node",
        ),
        suffix: [],
      });
      roots.push({
        directory: join(value("LOCALAPPDATA")!, "nvm"),
        suffix: [],
      });
      roots.push({
        directory: join(value("LOCALAPPDATA")!, "fnm", "node-versions"),
        suffix: ["installation"],
      });
    }
    if (value("APPDATA"))
      roots.push({ directory: join(value("APPDATA")!, "nvm"), suffix: [] });
  } else {
    roots.push({
      directory: join(
        value("NVM_DIR") || join(home, ".nvm"),
        "versions",
        "node",
      ),
      suffix: ["bin"],
    });
    roots.push({
      directory: join(
        value("XDG_DATA_HOME") || join(home, ".local", "share"),
        "fnm",
        "node-versions",
      ),
      suffix: ["installation", "bin"],
    });
    roots.push({
      directory: join(home, ".fnm", "node-versions"),
      suffix: ["installation", "bin"],
    });
  }
  if (value("FNM_DIR"))
    roots.unshift({
      directory: join(value("FNM_DIR")!, "node-versions"),
      suffix: windows ? ["installation"] : ["installation", "bin"],
    });
  const groups = await Promise.all(
    roots.map(async ({ directory, suffix }) => {
      try {
        return (await readdir(directory))
          .filter((name) => /^v?\d+\.\d+\.\d+$/.test(name))
          .sort((a, b) =>
            b
              .replace(/^v/, "")
              .localeCompare(a.replace(/^v/, ""), "en", { numeric: true }),
          )
          .map((name) => join(directory, name, ...suffix));
      } catch {
        return [];
      }
    }),
  );
  return [...new Set(groups.flat())];
}

/** Bounded, cancellable version probe. stdout is parsed strictly; diagnostics stay bounded. */
export function probeNodeVersion(
  executable: string,
  env: NodeJS.ProcessEnv,
  options: { signal?: AbortSignal; cwd?: string } = {},
): Promise<string> {
  const { signal, cwd } = options;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--version"], {
      env,
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    let finished = false;
    let stopped: Error | undefined;
    let closed = false;
    let cleaned = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      signal?.removeEventListener("abort", abort);
      if (stopped || error) reject(stopped ?? error);
      else resolve(output.trim());
    };
    const stop = (error: Error) => {
      if (finished || stopped) return;
      stopped = error;
      clearTimeout(timer);
      void killTree(child).then(
        () => {
          cleaned = true;
          if (closed) finish(error);
          else
            closeTimer = setTimeout(() => {
              stopped = new Error(`${error.message} 检测进程未在清理后关闭。`);
              child.stdout.destroy();
              finish(stopped);
            }, 1000);
        },
        () => {
          stopped = new Error(`${error.message} 无法清理 Node.js 检测进程。`);
          finish(stopped);
        },
      );
    };
    const abort = () => stop(new Error("Node.js 版本检测已取消。"));
    const timer = setTimeout(
      () => stop(new Error("Node.js 版本检测超时。")),
      3000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (finished || stopped) return;
      if (output.length + chunk.length > 1024) {
        stop(new Error("Node.js 版本输出无效。"));
        return;
      }
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (!stopped) finish(error);
    });
    child.on("close", (code) => {
      closed = true;
      if (!stopped || cleaned)
        finish(code === 0 ? undefined : new Error("Node.js 无法运行。"));
    });
    if (signal?.aborted) abort();
  });
}
