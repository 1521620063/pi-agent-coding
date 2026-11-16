import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseClientAction } from "../../src/shared/bridge";
import {
  discoverLocalResources,
  exactResourceRule,
  exactRuleState,
  patchResourceConfig,
  readResourceConfig,
  validateMcpName,
  packageCliSource,
  validatePackageSource,
} from "../../src/features/resource-config";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi resources 中文 "));
  roots.push(root);
  return root;
}

it("patches only the MCP setting while preserving credentials, unknown fields and unrelated text", async () => {
  const root = await fixture();
  const file = join(root, "mcp.json");
  const text =
    '{\r\n  "unknown": { "preserve": true },\r\n  "mcpServers": {\r\n    "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "secret" }, "oauth": {"clientSecret":"keep"} }\r\n  }\r\n}\r\n';
  await writeFile(file, text);
  const config = await readResourceConfig(file);
  const patched = patchResourceConfig(
    config,
    ["mcpServers", "docs", "enabled"],
    false,
  );
  expect(patched).toContain('"unknown": { "preserve": true }');
  expect(patched).toContain('"Authorization": "secret"');
  expect(JSON.parse(patched).mcpServers.docs).toMatchObject({
    enabled: false,
    oauth: { clientSecret: "keep" },
  });
  expect(patched).toContain("\r\n");
  expect(await readFile(file, "utf8")).toBe(text);
});

it("removes one rule or server without erasing neighboring configuration", () => {
  const value = {
    packages: ["npm:a", { source: "npm:b", skills: [], custom: 1 }],
    other: 42,
  };
  const config = { path: "settings.json", value, text: JSON.stringify(value) };
  const patched = patchResourceConfig(config, ["packages", 0], undefined);
  expect(JSON.parse(patched)).toEqual({
    packages: [{ source: "npm:b", skills: [], custom: 1 }],
    other: 42,
  });
});

it("refuses invalid or oversized JSON instead of resetting it", async () => {
  const root = await fixture();
  const file = join(root, "settings.json");
  await writeFile(file, '{"packages":');
  await expect(readResourceConfig(file)).rejects.toThrow("JSON 无效");
  await writeFile(file, " ".repeat(1_048_577));
  await expect(readResourceConfig(file)).rejects.toThrow("1 MiB");
  await expect(
    readResourceConfig(join(root, "missing.json")),
  ).resolves.toMatchObject({ value: {}, text: "" });
});

it("writes exact resource overrides without dropping glob rules or unrelated paths", () => {
  const target = resolve("fixture", "skills", "example", "SKILL.md");
  const file = resolve("fixture", "settings.json");
  const config = {
    path: file,
    text: "",
    value: {
      skills: [
        "./extra",
        "!**/hidden/**",
        `-${target}`,
        `+${target}`,
        "-./other.md",
      ],
    },
  };
  const result = exactResourceRule(config, "skills", target, true);
  expect(result).toEqual([
    "./extra",
    "!**/hidden/**",
    "-./other.md",
    `+${target}`,
  ]);
  expect(
    exactRuleState({ ...config, value: { skills: result } }, "skills", target),
  ).toBe(true);
});

it("treats a Skill directory exclusion as excluding its SKILL.md and lets enable replace it", () => {
  const target = resolve("fixture", "skills", "example", "SKILL.md");
  const config = {
    path: resolve("fixture", "settings.json"),
    text: "",
    value: { skills: ["-./skills/example", `+${target}`] },
  };
  expect(exactRuleState(config, "skills", target)).toBe(false);
  expect(exactResourceRule(config, "skills", target, true)).toEqual([
    `+${target}`,
  ]);
});

it("gives exact exclusions priority over inclusions regardless of order", () => {
  const target = "builtin:mcp";
  const config = {
    path: resolve("fixture", "settings.json"),
    text: "",
    value: { extensions: [`-${target}`, `+${target}`] },
  };
  expect(exactRuleState(config, "extensions", target)).toBe(false);
  expect(exactRuleState(config, "extensions", target, "project")).toBe(true);
});

it("discovers nested Skills and extension entry points without walking node_modules", async () => {
  const root = await fixture();
  const skill = join(root, "skills", "nested", "example");
  const extension = join(root, "extensions", "custom");
  await mkdir(skill, { recursive: true });
  await mkdir(extension, { recursive: true });
  await mkdir(join(root, "skills", "node_modules", "ignored"), {
    recursive: true,
  });
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: example\ndescription: test\n---\n",
  );
  await writeFile(
    join(root, "skills", "node_modules", "ignored", "SKILL.md"),
    "ignored",
  );
  await writeFile(join(extension, "index.ts"), "export default () => {};\n");
  const explicitModule = join(root, "extensions", "explicit.mjs");
  await writeFile(explicitModule, "export default () => {};\n");
  expect(
    (await discoverLocalResources([join(root, "skills")], "skills")).items.map(
      (item) => item.path,
    ),
  ).toEqual([join(skill, "SKILL.md")]);
  expect(
    (
      await discoverLocalResources([join(root, "extensions")], "extensions")
    ).items.map((item) => item.path),
  ).toEqual([join(extension, "index.ts")]);
  expect(
    (await discoverLocalResources([explicitModule], "extensions")).items.map(
      (item) => item.path,
    ),
  ).toEqual([explicitModule]);
});

it("keeps healthy extensions visible and reports an invalid neighboring manifest", async () => {
  const root = await fixture();
  const extensions = join(root, "extensions");
  const broken = join(extensions, "broken");
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, "package.json"), '{"private-secret": invalid}');
  await writeFile(join(extensions, "healthy.ts"), "export default () => {};");
  const result = await discoverLocalResources([extensions], "extensions");
  expect(result.items.map((item) => item.path)).toContain(
    join(extensions, "healthy.ts"),
  );
  expect(result).toMatchObject({
    warnings: [expect.stringContaining(join(broken, "package.json"))],
  });
  expect(JSON.stringify(result)).not.toContain("private-secret");
});

it("discovers an explicitly configured extension directory through its entry point", async () => {
  const root = await fixture();
  await writeFile(join(root, "index.ts"), "export default () => {};");
  await writeFile(join(root, "helper.ts"), "export const helper = true;");
  expect(
    (await discoverLocalResources([root], "extensions")).items.map(
      (item) => item.path,
    ),
  ).toEqual([join(root, "index.ts")]);
});
it("discovers a manifest before index files and respects an auto-discovery root entry", async () => {
  const root = await fixture();
  const extensions = join(root, "extensions");
  await mkdir(extensions);
  await writeFile(join(extensions, "index.ts"), "export default () => {};");
  await writeFile(join(extensions, "helper.ts"), "export const helper = true;");
  expect(
    (await discoverLocalResources([extensions], "extensions")).items.map(
      (item) => item.path,
    ),
  ).toEqual([join(extensions, "index.ts")]);
  await writeFile(
    join(extensions, "package.json"),
    JSON.stringify({ pi: { extensions: ["./custom.ts"] } }),
  );
  expect(
    (await discoverLocalResources([extensions], "extensions")).items.map(
      (item) => item.path,
    ),
  ).toEqual([join(extensions, "package.json")]);
});

it("resolves stored local package paths against their settings file for CLI operations", async () => {
  const root = await fixture();
  const config = {
    path: join(root, ".pi", "settings.json"),
    text: "",
    value: {},
  };
  expect(packageCliSource("../local-package", config)).toBe(
    join(root, "local-package"),
  );
  expect(packageCliSource("npm:@example/tools", config)).toBe(
    "npm:@example/tools",
  );
  expect(packageCliSource("git:github.com/example/tools", config)).toBe(
    "git:github.com/example/tools",
  );
  expect(packageCliSource("git://example.com/user/tools", config)).toBe(
    "git://example.com/user/tools",
  );
});
it("rejects option injection and invalid MCP identities", () => {
  for (const value of [
    "--all",
    "npm:test\n--force",
    "",
    " npm:test",
    "pi",
    "self",
  ])
    expect(validatePackageSource(value)).toBeTruthy();
  for (const value of [
    "npm:@scope/pkg@1.0.0",
    "git:github.com/user/repo",
    "C:\\path with spaces\\package",
  ])
    expect(validatePackageSource(value)).toBeUndefined();
  for (const value of ["__proto__", "../../server", "server name", ""])
    expect(validateMcpName(value)).toBeTruthy();
  expect(validateMcpName("docs-tools_1")).toBeUndefined();
});

it("accepts only resource operations with bounded opaque IDs, scopes and kinds", () => {
  const action = {
    type: "resourceAction",
    operation: "toggle",
    scope: "project",
    kind: "mcp",
    id: "a123-b456",
  };
  expect(parseClientAction(action)).toEqual(action);
  for (const extra of [
    { path: "/etc/passwd" },
    { operation: "request" },
    { scope: "global" },
    { kind: "models" },
    { id: "../../auth.json" },
    { id: 42 },
    { scope: ["project"] },
    { kind: ["mcp"] },
  ])
    expect(parseClientAction({ ...action, ...extra })).toBeUndefined();
  expect(parseClientAction({ type: "showResources" })).toEqual({
    type: "showResources",
  });
});
