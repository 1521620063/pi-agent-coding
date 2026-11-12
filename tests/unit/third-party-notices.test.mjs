import { afterEach, expect, it } from "vitest";
import { build } from "esbuild";
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
  await writeFile(
    join(dependency, "index.js"),
    "export { value } from './value.js';",
  );
  await writeFile(join(dependency, "value.js"), "export const value = 42;");
  if (withLicense)
    await writeFile(
      join(dependency, "LICENSE"),
      "Copyright Fixture Authors\nRedistribution conditions\nFull disclaimer\n",
    );
  await writeFile(join(dependency, "NOTICE.txt"), "Additional attribution\n");
  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents:
        "import { value } from '@example/component'; console.log(value);",
      resolveDir: root,
    },
    bundle: true,
    write: false,
    metafile: true,
  });
  return {
    root,
    metafile: result.metafile,
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
