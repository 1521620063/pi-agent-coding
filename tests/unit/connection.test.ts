import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
vi.mock("vscode", async () => {
  const { pathToFileURL } = await import("node:url");
  return {
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: pathToFileURL(process.cwd()) }],
      getConfiguration: () => ({ get: () => undefined }),
    },
    env: {},
  };
});
import { createConnection } from "../../src/host/connection";

it("passes an explicit current session to restoration instead of relying on history", async () => {
  const restoreLast = vi.fn(async (_path?: string) => true);
  const refresh = vi.fn(async () => {});
  const connect = vi.fn(async () => {});
  const connection = createConnection({
    controller: { configure() {}, connect } as never,
    sessions: { restoreLast, refresh } as never,
    models: { refresh } as never,
    commands: { refresh } as never,
    usage: { refreshStats: refresh } as never,
    ui: { dispose() {} } as never,
    report: vi.fn(),
  });
  const workspaceUri = pathToFileURL(process.cwd()).toString();
  await connection.connect(workspaceUri, "/fixture/current.jsonl");
  expect(connect).toHaveBeenCalledWith(workspaceUri);
  expect(restoreLast).toHaveBeenCalledWith("/fixture/current.jsonl");
  expect(connection.initializing).toBe(false);
});
