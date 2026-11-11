import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiLaunch, assertWorkspace } from "../../src/pi/launcher";
it("finds a PI official launcher in a path containing spaces and Unicode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi space 中文 "));
  try {
    await writeFile(join(dir, "pi.ps1"), "# wrapper");
    await writeFile(join(dir, "pi-launcher.js"), "// official launcher");
    const launch = await resolvePiLaunch({}, { ...process.env, PATH: dir });
    expect(launch.args).toContain(join(dir, "pi-launcher.js"));
    const explicit = await resolvePiLaunch(
      {
        executablePath: join(dir, "pi-launcher.js"),
        nodePath: process.execPath,
      },
      process.env,
    );
    expect(explicit.command).toBe(process.execPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("rejects missing executables and unsafe workspace contexts", async () => {
  await expect(
    resolvePiLaunch({ executablePath: "C:/missing/pi.exe" }, {}),
  ).rejects.toThrow(/PI/);
  expect(() =>
    assertWorkspace({ trusted: false, uri: "file:///C:/work" }),
  ).toThrow(/trust/i);
  expect(() =>
    assertWorkspace({ trusted: true, uri: "vscode-remote://ssh/work" }),
  ).toThrow(/local/i);
  expect(() => assertWorkspace({ trusted: true })).toThrow(/workspace/i);
});
