import { expect, it } from "vitest";
import {
  mkdtemp,
  writeFile,
  rm,
  mkdir,
  chmod,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolvePiLaunch,
  assertWorkspace,
  installationDirectories,
} from "../../src/pi/launcher";
it("finds a PI official launcher in a path containing spaces and Unicode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi space 中文 "));
  try {
    await writeFile(
      join(dir, process.platform === "win32" ? "pi.ps1" : "pi"),
      "#!/usr/bin/env node\n",
    );
    await chmod(
      join(dir, process.platform === "win32" ? "pi.ps1" : "pi"),
      0o755,
    );
    await writeFile(join(dir, "pi-launcher.js"), "// official launcher");
    const launch = await resolvePiLaunch(
      { nodePath: process.execPath },
      { ...process.env, PATH: dir },
    );
    expect(process.platform === "win32" ? launch.args[0] : launch.command).toBe(
      join(dir, process.platform === "win32" ? "pi-launcher.js" : "pi"),
    );
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

it.skipIf(process.platform === "win32")(
  "finds PI and Node without a shell PATH and keeps child tools on that PATH",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "pi home 中文 "));
    try {
      const bin = join(home, ".local", "bin");
      const nodeBin = join(home, ".volta", "bin");
      await mkdir(bin, { recursive: true });
      await mkdir(nodeBin, { recursive: true });
      await writeFile(join(bin, "pi"), "#!/usr/bin/env node\n");
      await chmod(join(bin, "pi"), 0o755);
      await writeFile(join(nodeBin, "node"), "node fixture");
      await chmod(join(nodeBin, "node"), 0o755);
      const launch = await resolvePiLaunch(
        {},
        { HOME: home, PATH: "/usr/bin:/bin" },
      );
      expect(launch.command).toBe(join(bin, "pi"));
      expect(launch.env.PATH).toContain(nodeBin);
      expect(launch.env.PATH).toContain(bin);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
it("reports a missing configured Node distinctly for a JavaScript launcher", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi no node "));
  try {
    const cli = join(dir, "cli.js");
    await writeFile(cli, "// fixture");
    await expect(
      resolvePiLaunch(
        { executablePath: cli, nodePath: join(dir, "missing-node") },
        { HOME: dir, PATH: dir },
      ),
    ).rejects.toThrow(/Node.js/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it.skipIf(process.platform === "win32")(
  "resolves a POSIX npm symlink using the configured Node",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi npm "));
    try {
      const cli = join(dir, "cli.js");
      await writeFile(cli, "#!/usr/bin/env node\n");
      await symlink(cli, join(dir, "pi"));
      const launch = await resolvePiLaunch(
        { executablePath: join(dir, "pi"), nodePath: process.execPath },
        { PATH: dir },
      );
      expect(launch.command).toBe(process.execPath);
      expect(launch.args).toEqual([await realpath(cli)]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.each([".cmd", ".ps1", ".bat"])(
  "resolves an npm %s shim without executing shell text",
  async (extension) => {
    const dir = await mkdtemp(join(tmpdir(), "pi npm 中文 "));
    try {
      const pkg = join(
        dir,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
      );
      await mkdir(join(pkg, "dist"), { recursive: true });
      await writeFile(
        join(pkg, "package.json"),
        JSON.stringify({ bin: { pi: "dist/cli.js" } }),
      );
      await writeFile(join(pkg, "dist", "cli.js"), "// fixture");
      const shim = join(dir, `pi${extension}`);
      await writeFile(shim, "arbitrary shell text must not execute");
      const launch = await resolvePiLaunch(
        { executablePath: shim, nodePath: process.execPath },
        { Path: dir },
      );
      expect(launch.command).toBe(process.execPath);
      expect(launch.args).toEqual([
        join(
          await realpath(dir),
          "node_modules",
          "@earendil-works",
          "pi-coding-agent",
          "dist",
          "cli.js",
        ),
      ]);
      expect(launch.env.Path).toContain(dir);
      expect(launch.env.PATH).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("rejects an unrecognized Windows shim and invalid explicit Node", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi invalid "));
  try {
    const shim = join(dir, "pi.cmd");
    await writeFile(shim, "echo custom wrapper");
    await expect(resolvePiLaunch({ executablePath: shim }, {})).rejects.toThrow(
      /无法识别/,
    );
    const cli = join(dir, "cli.js");
    await writeFile(cli, "// fixture");
    await expect(
      resolvePiLaunch(
        { executablePath: cli, nodePath: join(dir, "missing-node") },
        {},
      ),
    ).rejects.toThrow(/Node.js/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "resolves the managed installer current version and follows an update",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "pi managed 中文 "));
    try {
      const bin = join(home, ".pi", "agent", "bin");
      const root = join(home, ".pi", "agent", "install");
      await mkdir(bin, { recursive: true });
      const script = join(bin, "pi");
      await writeFile(
        script,
        "#!/bin/sh\n# PI_MANAGED_INSTALL_ROOT install/current-version\nexit 99\n",
      );
      await chmod(script, 0o755);
      for (const version of ["1.5.2", "1.5.3"]) {
        const pkg = join(
          root,
          "releases",
          version,
          "node_modules",
          "@earendil-works",
          "pi-coding-agent",
        );
        await mkdir(pkg, { recursive: true });
        await writeFile(
          join(pkg, "package.json"),
          JSON.stringify({ bin: "cli.js" }),
        );
        await writeFile(join(pkg, "cli.js"), "// fixture");
        await writeFile(join(root, "current-version"), version + "\n");
        const launch = await resolvePiLaunch(
          { nodePath: process.execPath },
          { HOME: home, PATH: "" },
        );
        expect(launch.command).toBe(process.execPath);
        expect(launch.args[0]).toContain(version);
        expect(launch.env.PI_MANAGED_INSTALL_ROOT).toBe(
          join(await realpath(home), ".pi", "agent", "install"),
        );
      }
      await writeFile(join(root, "current-version"), "../escape");
      await expect(
        resolvePiLaunch({ nodePath: process.execPath }, { HOME: home }),
      ).rejects.toThrow(/版本标记/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "finds the nvm default without evaluating shell configuration",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "pi nvm "));
    try {
      const nvm = join(home, ".nvm");
      await mkdir(join(nvm, "alias"), { recursive: true });
      await writeFile(join(nvm, "alias", "default"), "v24.22.3\n");
      const bin = join(nvm, "versions", "node", "v24.22.3", "bin");
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, "pi"), "#!/usr/bin/env node\n");
      await writeFile(join(bin, "node"), "node fixture");
      await chmod(join(bin, "pi"), 0o755);
      await chmod(join(bin, "node"), 0o755);
      const launch = await resolvePiLaunch({}, { HOME: home, PATH: "" });
      expect(launch.command).toBe(join(bin, "pi"));
      expect(launch.env.PATH).toContain(bin);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "rejects custom POSIX shell wrappers",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi wrapper "));
    try {
      const script = join(dir, "pi");
      await writeFile(script, "#!/bin/sh\necho should-not-run\n");
      await chmod(script, 0o755);
      await expect(
        resolvePiLaunch({ executablePath: script }, {}),
      ).rejects.toThrow(/shell 启动器/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "discovers the Windows npm prefix and Node without PATH",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi windows 中文 "));
    try {
      const npm = join(dir, "AppData", "npm");
      const nodeBin = join(dir, "Program Files", "nodejs");
      await mkdir(npm, { recursive: true });
      await mkdir(nodeBin, { recursive: true });
      await writeFile(join(npm, "pi.cmd"), "@echo off");
      await writeFile(join(npm, "pi-launcher.js"), "// fixture");
      await writeFile(join(nodeBin, "node.exe"), "node fixture");
      const launch = await resolvePiLaunch(
        {},
        {
          USERPROFILE: dir,
          APPDATA: join(dir, "AppData"),
          ProgramFiles: join(dir, "Program Files"),
          Path: "",
        },
      );
      expect(launch.command).toBe(join(nodeBin, "node.exe"));
      expect(launch.args[0]).toBe(join(await realpath(npm), "pi-launcher.js"));
      expect(launch.env.Path).toContain(nodeBin);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("includes Windows user npm, Volta, nvm and system Node installation locations", () => {
  const env = {
    USERPROFILE: "user-home",
    APPDATA: "roaming",
    LOCALAPPDATA: "local",
    ProgramFiles: "programs",
    NVM_SYMLINK: "selected-nvm",
  };
  expect(installationDirectories(env, "win32")).toEqual(
    expect.arrayContaining([
      join("roaming", "npm"),
      join("local", "Volta", "bin"),
      join("programs", "nodejs"),
      "selected-nvm",
    ]),
  );
});
