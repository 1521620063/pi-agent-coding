import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as vscode from "vscode";

const host = vi.hoisted(() => ({
  trusted: true,
  remote: undefined as string | undefined,
  folders: [] as { uri: { toString(): string } }[],
  config: {} as Record<string, unknown>,
  choice: undefined as string | undefined,
  notice: vi.fn(),
  external: vi.fn(),
  command: vi.fn(),
  post: vi.fn(),
  action: undefined as
    | undefined
    | ((
        action: import("../../src/shared/bridge").ClientAction,
      ) => Promise<void>),
}));
vi.mock("../../src/sidebar/provider", () => ({
  createSidebarProvider: (_store: unknown, action: typeof host.action) => {
    host.action = action;
    return { post: host.post, isVisible: true, dispose() {} };
  },
}));
vi.mock("vscode", () => ({
  workspace: {
    get isTrusted() {
      return host.trusted;
    },
    get workspaceFolders() {
      return host.folders;
    },
    getConfiguration: () => ({ get: (key: string) => host.config[key] }),
  },
  env: {
    get remoteName() {
      return host.remote;
    },
    openExternal: host.external,
  },
  Uri: { parse: (value: string) => new URL(value) },
  window: {
    state: { focused: true },
    createOutputChannel: () => ({ append() {}, dispose() {} }),
    registerWebviewViewProvider: () => ({ dispose() {} }),
    showInformationMessage: (...args: unknown[]) => {
      host.notice(...args);
      return Promise.resolve(host.choice);
    },
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: host.command,
  },
}));
import { activate, deactivate } from "../../src/extension";

let context: vscode.ExtensionContext;
beforeEach(() => {
  vi.clearAllMocks();
  host.trusted = true;
  host.remote = undefined;
  host.choice = undefined;
  host.folders = [{ uri: pathToFileURL(process.cwd()) }];
  host.config = {
    executablePath: resolve("tests/fixtures/fake-pi.mjs"),
    nodePath: process.execPath,
  };
  context = {
    extension: { id: "SilasPaul.pi-coding-agent" },
    subscriptions: [],
    workspaceState: { get: () => undefined, update: async () => {} },
  } as unknown as vscode.ExtensionContext;
});

it.each(["SilasPaul.pi-coding-agent", "other-publisher.pi-coding-agent"])(
  "opens settings for the running extension %s",
  async (id) => {
    host.folders = [];
    Object.assign(context, { extension: { id } });
    activate(context);
    await host.action!({ type: "settings" });
    expect(host.command).toHaveBeenCalledWith(
      "workbench.action.openSettings",
      `@ext:${id}`,
    );
  },
);
afterEach(async () => {
  for (const disposable of context.subscriptions) disposable.dispose();
  await deactivate();
});

it("automatically connects and loads models on activation without a sidebar action", async () => {
  const { store } = activate(context);
  await vi.waitFor(() => {
    expect(store.getSnapshot().connection).toBe("connected");
    expect(store.getSnapshot().models).toHaveLength(1);
  });
  expect(host.notice).not.toHaveBeenCalled();
});

it("keeps PI disconnected after a user disconnects the automatic connection", async () => {
  const { store, controller } = activate(context);
  await vi.waitFor(() => expect(store.getSnapshot().models).toHaveLength(1));
  await controller.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(store.getSnapshot().connection).toBe("disconnected");
  expect(controller.pid).toBeUndefined();
});

it("executes ! shortcuts through PI bash, acknowledges completion, and rejects attachments", async () => {
  const { store, controller } = activate(context);
  await vi.waitFor(() => expect(store.getSnapshot().models).toHaveLength(1));
  const request = vi
    .spyOn(controller, "request")
    .mockResolvedValue({ output: "ok", exitCode: 0 });
  await host.action!({
    type: "send",
    text: "!echo PI",
    attachmentIds: [],
    mode: "followUp",
  });
  expect(request).toHaveBeenCalledWith(
    {
      type: "bash",
      id: expect.any(String),
      command: "echo PI",
      excludeFromContext: false,
    },
    { timeoutMs: 0 },
  );
  expect(host.post).toHaveBeenLastCalledWith({
    type: "sent",
    attachmentIds: [],
  });
  expect(store.getSnapshot().shell?.output).toBe("ok");
  request.mockClear();
  await expect(
    host.action!({
      type: "send",
      text: "!echo PI",
      attachmentIds: ["file"],
      mode: "followUp",
    }),
  ).rejects.toThrow("附件");
  expect(request).not.toHaveBeenCalled();
});

it.each(["untrusted", "remote", "missing folder", "virtual"])(
  "does not auto-start PI in a %s workspace",
  async (kind) => {
    if (kind === "untrusted") host.trusted = false;
    if (kind === "remote") host.remote = "ssh-remote";
    if (kind === "missing folder") host.folders = [];
    if (kind === "virtual")
      host.folders = [{ uri: new URL("vscode-vfs://host/work") }];
    const { store, controller } = activate(context);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.getSnapshot().connection).toBe("disconnected");
    expect(controller.pid).toBeUndefined();
    expect(host.notice).not.toHaveBeenCalled();
  },
);

it("offers official installation help when PI cannot be found", async () => {
  host.config.executablePath = resolve("missing-pi-test", "pi.exe");
  host.choice = "打开安装说明";
  const { store } = activate(context);
  await vi.waitFor(() => expect(host.external).toHaveBeenCalledOnce());
  expect(store.getSnapshot().connection).toBe("error");
  expect(host.notice.mock.calls[0]).toEqual([
    expect.stringContaining("PI"),
    "打开安装说明",
    "配置 PI 路径",
  ]);
  expect(host.external.mock.calls[0][0].protocol).toBe("https:");
});

it("lets users configure an existing PI installation instead", async () => {
  host.config.executablePath = resolve("missing-pi-test", "pi.exe");
  host.choice = "配置 PI 路径";
  activate(context);
  await vi.waitFor(() =>
    expect(host.command).toHaveBeenCalledWith(
      "workbench.action.openSettings",
      "pi.executablePath",
    ),
  );
  expect(host.external).not.toHaveBeenCalled();
});

it("does not suggest installing PI for an invalid launcher configuration", async () => {
  host.config.executablePath = "relative-pi";
  const { store } = activate(context);
  await vi.waitFor(() => expect(store.getSnapshot().connection).toBe("error"));
  expect(store.getSnapshot().error).toContain("absolute path");
  expect(host.notice).not.toHaveBeenCalled();
});
