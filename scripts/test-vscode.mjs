import { runTests } from "@vscode/test-electron";
import { build } from "esbuild";
import { mkdir, mkdtemp, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
// Codex may itself run under Electron's Node mode; do not pass it to Code.exe.
delete process.env.ELECTRON_RUN_AS_NODE;
await mkdir(".vscode-test", { recursive: true });
await build({
  entryPoints: ["tests/vscode/suite.ts"],
  outfile: ".vscode-test/suite.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode", "mocha"],
});
const workspace = await mkdtemp(join(tmpdir(), "pi-vscode-test-"));
const userData = await mkdtemp(join(tmpdir(), "pi-vscode-user-"));
await mkdir(join(userData, "User"));
// PI paths are machine-scoped and VS Code ignores them in workspace settings.
// Put the fake launcher in this run's isolated user profile.
await writeFile(
  join(userData, "User", "settings.json"),
  JSON.stringify({
    "pi.executablePath": resolve("tests/fixtures/fake-pi.mjs"),
    "pi.nodePath": process.execPath,
    "workbench.startupEditor": "none",
    "window.restoreWindows": "none",
  }),
);
await mkdir(join(workspace, ".vscode"));
await writeFile(
  join(workspace, ".vscode/settings.json"),
  JSON.stringify({
    "pi.executablePath": resolve("tests/fixtures/fake-pi.mjs"),
    "pi.nodePath": process.execPath,
    "workbench.startupEditor": "none",
    "window.restoreWindows": "none",
  }),
);
const localExecutables =
  process.platform === "win32"
    ? [
        join(
          process.env.LOCALAPPDATA ?? "",
          "Programs",
          "Microsoft VS Code",
          "Code.exe",
        ),
        join(process.env.ProgramFiles ?? "", "Microsoft VS Code", "Code.exe"),
      ]
    : process.platform === "darwin"
      ? ["/Applications", join(process.env.HOME ?? "", "Applications")].flatMap(
          (directory) =>
            ["Code", "Electron"].map((binary) =>
              join(
                directory,
                "Visual Studio Code.app",
                "Contents",
                "MacOS",
                binary,
              ),
            ),
        )
      : [];
let vscodeExecutablePath = process.env.PI_TEST_VSCODE;
for (const candidate of localExecutables) {
  if (vscodeExecutablePath) break;
  try {
    await access(candidate);
    vscodeExecutablePath = candidate;
  } catch {}
}
await runTests({
  extensionDevelopmentPath: resolve(process.env.PI_TEST_EXTENSION_DIR ?? "."),
  extensionTestsPath: resolve(".vscode-test/suite.cjs"),
  vscodeExecutablePath,
  extensionTestsEnv: { PI_TEST_NODE: process.execPath },
  launchArgs: [
    workspace,
    "--disable-extensions",
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
    "--user-data-dir",
    userData,
    "--extensions-dir",
    resolve(
      process.env.PI_TEST_EXTENSION_DIR
        ? ".vscode-test/installed-extensions"
        : ".vscode-test/extensions",
    ),
  ],
});
