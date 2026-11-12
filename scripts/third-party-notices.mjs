import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Use build inputs rather than all installed packages: development tools and
// unused runtime dependencies do not belong in the distributed notices.
export async function writeThirdPartyNotices(
  metafiles,
  { root = process.cwd(), output = join(root, "THIRD_PARTY_NOTICES.txt") } = {},
) {
  const directories = new Set();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      const normalized = input.replaceAll("\\", "/");
      const marker = normalized.lastIndexOf("node_modules/");
      if (marker < 0) continue;
      const parts = normalized
        .slice(marker + "node_modules/".length)
        .split("/");
      const name = parts[0].startsWith("@")
        ? parts.slice(0, 2).join("/")
        : parts[0];
      directories.add(
        resolve(root, normalized.slice(0, marker), "node_modules", name),
      );
    }
  }

  const packages = [];
  for (const directory of directories) {
    const metadata = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          /^(licen[sc]e|copying|notice|copyright)([._-]|$)/i.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
    if (!files.some((file) => /^(licen[sc]e|copying)([._-]|$)/i.test(file))) {
      throw new Error(
        `Missing license text for ${metadata.name}@${metadata.version}`,
      );
    }
    const texts = await Promise.all(
      files.map(
        async (file) =>
          `--- ${file} ---\n${(await readFile(join(directory, file), "utf8")).replace(/\r\n/g, "\n")}\n`,
      ),
    );
    packages.push({
      key: `${metadata.name}@${metadata.version}`,
      text: `${metadata.name}@${metadata.version}\nDeclared license: ${metadata.license ?? "See license text below"}\n\n${texts.join("\n")}`,
    });
  }
  packages.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const unique = [
    ...new Map(packages.map((item) => [item.key, item])).values(),
  ];
  const heading =
    "THIRD-PARTY SOFTWARE NOTICES\n\nGenerated from the extension build inputs and installed dependency license files.\nThese components retain their respective copyrights and license terms.\nThe project's MIT license does not replace these terms.\n\n";
  // Complete validation and reads before replacing a previously valid file.
  await writeFile(
    output,
    heading +
      unique.map((item) => `${"=".repeat(72)}\n${item.text}`).join("\n"),
    "utf8",
  );
}
