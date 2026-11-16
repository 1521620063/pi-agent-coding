import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    // The default Vitest 5 pool fails suite collection on the Windows baseline.
    pool: process.platform === "win32" ? "vmThreads" : undefined,
    testTimeout: 15000,
    exclude: ["node_modules/**", "tests/vscode/**", ".vscode-test/**"],
  },
});
