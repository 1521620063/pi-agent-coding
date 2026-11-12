import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeThirdPartyNotices } from "../../scripts/third-party-notices.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(withLicense = true) {
  const root = await mkdtemp(join(tmpdir(), "pi-notices-"));
  roots.push(root);
  const dependency = join(root, "node_modules", "@example", "component");
  await mkdir(dependency, { recursive: true });
  await writeFile(
    join(dependency, "package.json"),
    JSON.stringify({
      name: "@example/component",
      version: "1.2.3",
      license: "BSD-3-Clause",
      main: "index.js",
    }),
  );
  if (withLicense)
    await writeFile(
      join(dependency, "LICENSE"),
      "Copyright Fixture Authors\nRedistribution conditions\nFull disclaimer\n",
    );
  await writeFile(join(dependency, "NOTICE.txt"), "Additional attribution\n");
  // Exercise notice generation independently of esbuild's service startup.
  // The package command verifies the real build and its generated metafile.
  const metafile = {
    inputs: {
      "node_modules/@example/component/index.js": { bytes: 42, imports: [] },
      "node_modules/@example/component/value.js": { bytes: 24, imports: [] },
      "src/extension.ts": { bytes: 10, imports: [] },
    },
  };
  return {
    root,
    metafile,
    output: join(root, "THIRD_PARTY_NOTICES.txt"),
  };
}

it("ships complete license and NOTICE text once for each bundled package", async () => {
  const { root, metafile, output } = await fixture();
  await writeThirdPartyNotices([metafile, metafile], { root, output });
  const notices = await readFile(output, "utf8");
  expect(notices.match(/@example\/component@1\.2\.3/g)).toHaveLength(1);
  expect(notices).toContain("BSD-3-Clause");
  expect(notices).toContain(
    "Copyright Fixture Authors\nRedistribution conditions\nFull disclaimer\n",
  );
  expect(notices).toContain("Additional attribution\n");
  expect(notices).not.toContain(root);
});

it("rejects missing license text without replacing an existing notice file", async () => {
  const { root, metafile, output } = await fixture(false);
  await writeFile(output, "previous valid notices");
  await expect(
    writeThirdPartyNotices([metafile], { root, output }),
  ).rejects.toThrow(/license.*@example\/component/i);
  expect(await readFile(output, "utf8")).toBe("previous valid notices");
});
