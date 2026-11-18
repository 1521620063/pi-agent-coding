import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  managedNodeDirectories,
  supportsPiNode,
} from "../../src/pi/node-runtime";

it.each([
  ["v14.21.3", false],
  ["v16.20.2", false],
  ["v18.20.8", false],
  ["v20.19.0", false],
  ["v22.18.9", false],
  ["v22.19.0", true],
  ["22.20.0", true],
  ["v23.0.0", true],
  ["v24.22.3", true],
  ["v26.0.0", true],
  ["v24.0.0-rc.1", false],
  ["v24", false],
  ["garbage\nv24.0.0", false],
  ["", false],
])("checks PI's runtime requirement for %s", (version, expected) => {
  expect(supportsPiNode(version)).toBe(expected);
});

it.each(["nvm", "volta", "fnm"])(
  "finds inactive %s versions newest first without reading shell profiles",
  async (manager) => {
    const home = await mkdtemp(join(tmpdir(), "pi node versions 中文 "));
    try {
      const root = join(home, manager);
      const windows = process.platform === "win32";
      const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home };
      let versions: string;
      let suffix: string[];
      if (manager === "nvm") {
        env[windows ? "NVM_HOME" : "NVM_DIR"] = root;
        versions = windows ? root : join(root, "versions", "node");
        suffix = windows ? [] : ["bin"];
      } else if (manager === "volta") {
        env.VOLTA_HOME = root;
        versions = join(root, "tools", "image", "node");
        suffix = windows ? [] : ["bin"];
      } else {
        env.FNM_DIR = root;
        versions = join(root, "node-versions");
        suffix = windows ? ["installation"] : ["installation", "bin"];
      }
      for (const version of [
        "v14.21.3",
        "v24.9.0",
        "v24.22.3",
        "not-a-version",
      ]) {
        await mkdir(join(versions, version, ...suffix), { recursive: true });
      }
      expect(await managedNodeDirectories(env)).toEqual([
        join(versions, "v24.22.3", ...suffix),
        join(versions, "v24.9.0", ...suffix),
        join(versions, "v14.21.3", ...suffix),
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
