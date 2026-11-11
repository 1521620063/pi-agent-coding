import { build, context } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
const configs = [
  {
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    external: ["vscode"],
    target: "node20",
  },
  {
    entryPoints: ["webview/main.ts"],
    outfile: "dist/webview.js",
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: true,
  },
];
for (const options of configs) {
  const config = {
    bundle: true,
    sourcemap: true,
    logLevel: "info",
    ...options,
  };
  if (process.argv.includes("--watch")) await (await context(config)).watch();
  else await build(config);
}
for (const file of ["theme.css", "styles.css"])
  await copyFile(`webview/${file}`, `dist/${file}`);
