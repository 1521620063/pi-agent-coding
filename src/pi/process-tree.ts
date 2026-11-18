import { spawn } from "node:child_process";
import { join } from "node:path";

/** Only pass children owned by this extension, detached into their own POSIX group. */
export async function killTree(child: {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}) {
  if (!child.pid) return;
  if (process.platform === "win32")
    await new Promise<void>((resolve, reject) => {
      const systemRoot = process.env.SystemRoot || process.env.WINDIR;
      const killer = spawn(
        systemRoot
          ? join(systemRoot, "System32", "taskkill.exe")
          : "taskkill.exe",
        ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      let settled = false;
      const finish = (fallback: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          if (fallback) child.kill("SIGKILL");
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      const timer = setTimeout(() => {
        try {
          killer.kill();
        } catch {
          // The cleanup command may already have exited; still stop the owned child.
        }
        finish(true);
      }, 2000);
      killer.on("error", () => finish(true));
      killer.on("exit", (code) => finish(code !== 0));
    });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}
