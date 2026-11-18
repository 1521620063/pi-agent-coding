import { expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeNodeVersion } from "../../src/pi/node-runtime";

it("probes the real Node executable without launching PI", async () => {
  expect(await probeNodeVersion(process.execPath, process.env)).toBe(
    process.version,
  );
});

it("rejects an executable that cannot start", async () => {
  await expect(
    probeNodeVersion(join(tmpdir(), "missing-pi-node.exe"), process.env),
  ).rejects.toThrow();
});

it("does not start an already cancelled runtime probe", () => {
  const abort = new AbortController();
  abort.abort();
  expect(() =>
    probeNodeVersion(process.execPath, process.env, { signal: abort.signal }),
  ).toThrow();
});

it.skipIf(process.platform === "win32")(
  "cancels an owned version probe and cleans up its process group",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi slow node 中文 "));
    const abort = new AbortController();
    try {
      const executable = join(directory, "node");
      const pidFile = join(directory, "pid");
      await writeFile(
        executable,
        '#!/bin/sh\necho $$ > "$PI_PROBE_PID_FILE"\nexec sleep 30\n',
      );
      await chmod(executable, 0o755);
      const probing = probeNodeVersion(
        executable,
        { ...process.env, PI_PROBE_PID_FILE: pidFile },
        { signal: abort.signal },
      ).catch((error: unknown) => error);
      let pid: number | undefined;
      await expect
        .poll(async () => {
          try {
            pid = Number(await readFile(pidFile, "utf8"));
          } catch {
            /* The child has not started yet. */
          }
          return pid;
        })
        .toBeGreaterThan(0);
      abort.abort();
      expect(await probing).toBeInstanceOf(Error);
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      abort.abort();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
