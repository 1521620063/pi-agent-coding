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
import { delimiter, join, posix, win32 } from "node:path";
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
      { HOME: dir, USERPROFILE: dir, PATH: dir },
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
      const env = process.platform === "win32" ? { Path: dir } : { PATH: dir };
      const launch = await resolvePiLaunch(
        { executablePath: shim, nodePath: process.execPath },
        env,
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
      const pathKey = process.platform === "win32" ? "Path" : "PATH";
      expect(launch.env[pathKey]).toContain(dir);
      expect(launch.env[pathKey === "PATH" ? "Path" : "PATH"]).toBeUndefined();
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

it.skipIf(process.platform !== "win32").each([
  { key: "ProgramFiles", installation: "nodejs" },
  { key: "PROGRAMFILES", installation: "nodejs" },
  { key: "programfiles", installation: "nodejs" },
  { key: "PROGRAMFILES", installation: "Volta" },
])(
  "discovers Windows npm and Node without PATH using $key and $installation",
  async ({ key, installation }) => {
    const dir = await mkdtemp(join(tmpdir(), "pi windows 中文 "));
    try {
      const npm = join(dir, "AppData", "npm");
      const nodeBin = join(dir, "Program Files", installation);
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
          [key]: join(dir, "Program Files"),
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

it.skipIf(process.platform !== "win32")(
  "uses Node's first sorted PATH key regardless of environment insertion order",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi path 中文 "));
    try {
      const first = join(dir, "first");
      const second = join(dir, "second");
      for (const bin of [first, second]) {
        await mkdir(bin);
        await writeFile(join(bin, "pi.cmd"), "@echo off");
        await writeFile(join(bin, "pi-launcher.js"), "// fixture");
      }
      for (const source of [
        { PATH: first, Path: second },
        { Path: second, PATH: first },
      ]) {
        const launch = await resolvePiLaunch(
          { nodePath: process.execPath },
          source,
        );
        expect(launch.args).toEqual([
          join(await realpath(first), "pi-launcher.js"),
        ]);
        expect(launch.env.PATH).toContain(first);
        expect(launch.env.Path).toBeUndefined();
        expect(source).toEqual({ PATH: first, Path: second });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.each(["C:", "D:", "Z:"])(
  "resolves Windows installation locations on %s independently of the host platform",
  (drive) => {
    const base = `${drive}\\arbitrary 用户`;
    const paths = (name: string) => win32.join(base, name);
    const directories = installationDirectories(
      {
        userprofile: paths("profile"),
        HOME: paths("shell-home"),
        appdata: paths("roaming"),
        localappdata: paths("local"),
        PROGRAMFILES: paths("programs"),
        nvm_symlink: paths("selected-nvm"),
        volta_home: paths("custom-volta"),
        NPM_CONFIG_PREFIX: paths("custom-npm"),
      },
      "win32",
    );
    expect(directories).toEqual(
      expect.arrayContaining([
        win32.join(paths("profile"), ".pi", "agent", "bin"),
        win32.join(paths("roaming"), "npm"),
        win32.join(paths("local"), "Volta", "bin"),
        win32.join(paths("programs"), "nodejs"),
        win32.join(paths("programs"), "Volta"),
        paths("selected-nvm"),
        win32.join(paths("custom-volta"), "bin"),
        paths("custom-npm"),
      ]),
    );
    expect(directories).not.toContain(
      win32.join(paths("shell-home"), ".pi", "agent", "bin"),
    );
  },
);

it.each(["darwin", "linux"] as const)(
  "uses POSIX paths and case-sensitive environment names on %s",
  (platform) => {
    const directories = installationDirectories(
      {
        HOME: "/users/example 中文",
        USERPROFILE: "/ignored-profile",
        VOLTA_HOME: "/custom/volta",
        npm_config_prefix: "/custom/npm",
        NPM_CONFIG_PREFIX: "/ignored-prefix",
      },
      platform,
    );
    expect(directories).toEqual(
      expect.arrayContaining([
        posix.join("/users/example 中文", ".pi", "agent", "bin"),
        "/custom/volta/bin",
        "/custom/npm/bin",
      ]),
    );
    expect(directories).not.toContain("/ignored-prefix/bin");
  },
);

async function createInstallation(directory: string) {
  await mkdir(directory, { recursive: true });
  const entry = join(directory, "pi-launcher.js");
  const executable = join(
    directory,
    process.platform === "win32" ? "pi.cmd" : "pi",
  );
  const node = join(
    directory,
    process.platform === "win32" ? "node.exe" : "node",
  );
  await writeFile(entry, "// fixture");
  await chmod(entry, 0o755);
  if (process.platform === "win32") await writeFile(executable, "@echo off");
  else await symlink(entry, executable);
  await writeFile(node, "node fixture");
  await chmod(node, 0o755);
  return { executable, entry, node };
}

it.each(["executablePath", "nodePath"] as const)(
  "finds a relocated installation from %s without PATH",
  async (setting) => {
    const home = await mkdtemp(join(tmpdir(), "pi portable 用户 "));
    try {
      const installed = await createInstallation(join(home, "custom tools"));
      const launch = await resolvePiLaunch(
        {
          [setting]:
            setting === "nodePath" ? installed.node : installed.executable,
        },
        { HOME: home, USERPROFILE: home, PATH: "" },
      );
      expect(launch.command).toBe(installed.node);
      expect(launch.args).toEqual([await realpath(installed.entry)]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it.each([
  "PATH",
  "VOLTA_HOME",
  "npm_config_prefix",
  process.platform === "win32" ? "NVM_SYMLINK" : "NVM_BIN",
])("discovers a custom installation using %s", async (setting) => {
  const home = await mkdtemp(join(tmpdir(), "pi custom install 中文 "));
  try {
    const root = join(home, "relocated");
    const bin =
      setting === "VOLTA_HOME" ||
      (setting === "npm_config_prefix" && process.platform !== "win32")
        ? join(root, "bin")
        : root;
    const installed = await createInstallation(bin);
    const launch = await resolvePiLaunch(
      {},
      { HOME: home, USERPROFILE: home, PATH: "", [setting]: root },
    );
    expect(launch.command).toBe(installed.node);
    expect(launch.args).toEqual([await realpath(installed.entry)]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("keeps explicit settings ahead of PATH and PATH ahead of fallback installations", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi precedence 中文 "));
  try {
    const explicit = await createInstallation(join(home, "explicit"));
    const inherited = await createInstallation(join(home, "inherited"));
    const fallback = await createInstallation(
      process.platform === "win32"
        ? join(home, "fallback")
        : join(home, "fallback", "bin"),
    );
    const env = {
      HOME: home,
      USERPROFILE: home,
      PATH: join(home, "inherited"),
      npm_config_prefix: join(home, "fallback"),
    };
    const automatic = await resolvePiLaunch({}, env);
    expect(automatic.command).toBe(inherited.node);
    expect(automatic.args).toEqual([await realpath(inherited.entry)]);
    const selected = await resolvePiLaunch(
      { executablePath: explicit.executable, nodePath: explicit.node },
      env,
    );
    expect(selected.command).toBe(explicit.node);
    expect(selected.args).toEqual([await realpath(explicit.entry)]);
    expect(selected.env.PATH?.split(delimiter)[0]).toBe(join(home, "explicit"));
    const selectedPi = await resolvePiLaunch(
      { executablePath: explicit.executable },
      env,
    );
    expect(selectedPi.command).toBe(inherited.node);
    expect(selectedPi.args).toEqual([await realpath(explicit.entry)]);
    expect(fallback.node).not.toBe(automatic.command);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "keeps PATH separate from an unrelated POSIX Path variable",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "pi posix env "));
    try {
      const installed = await createInstallation(join(home, "actual"));
      const env = {
        HOME: home,
        PATH: join(home, "actual"),
        Path: "/unrelated",
      };
      const launch = await resolvePiLaunch({}, env);
      expect(launch.command).toBe(installed.node);
      expect(launch.env.Path).toBe("/unrelated");
      expect(env.PATH).toBe(join(home, "actual"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
