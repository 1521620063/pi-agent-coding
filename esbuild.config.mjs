import { build, context } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { writeThirdPartyNotices } from "./scripts/third-party-notices.mjs";
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
const metafiles = new Map();
for (const options of configs) {
  const config = {
    bundle: true,
    sourcemap: true,
    logLevel: "info",
    metafile: true,
    plugins: [
      {
        name: "third-party-notices",
        setup(builder) {
          builder.onEnd(async (result) => {
            if (result.errors.length || !result.metafile) return;
            metafiles.set(options.outfile, result.metafile);
            await writeThirdPartyNotices([...metafiles.values()]);
          });
        },
      },
    ],
    ...options,
  };
  if (process.argv.includes("--watch")) await (await context(config)).watch();
  else await build(config);
}
for (const file of ["theme.css", "styles.css"])
  await copyFile(`webview/${file}`, `dist/${file}`);
