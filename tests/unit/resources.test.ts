import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as vscode from "vscode";
import type { HostMessage } from "../../src/shared/bridge";
import type {
  ResourceItem,
  ResourceOperation,
  ResourceSnapshot,
} from "../../src/shared/resources";

const host = vi.hoisted(() => ({
  workspace: "",
  trusted: true,
  remote: undefined as string | undefined,
  inputs: [] as (string | undefined)[],
  input: vi.fn(),
  picks: [] as unknown[],
  documents: [] as any[],
  tasks: [] as any[],
  ended: undefined as ((event: any) => void) | undefined,
  taskEnded: undefined as ((event: any) => void) | undefined,
  saved: undefined as ((document: any) => void) | undefined,
  execute: vi.fn(),
  applyEdit: vi.fn(),
  open: vi.fn(),
  launch: vi.fn(),
}));
const uri = (file: string) => ({
  fsPath: resolve(file),
  scheme: "file",
  toString: () => pathToFileURL(resolve(file)).toString(),
});
vi.mock("vscode", () => ({
  Uri: { file: (file: string) => uri(file) },
  Range: class {
    constructor(
      public start: number,
      public end: number,
    ) {}
  },
  WorkspaceEdit: class {
    edit?: { uri: unknown; text: string };
    replace(uri: unknown, _range: unknown, text: string) {
      this.edit = { uri, text };
    }
  },
  ProcessExecution: class {
    constructor(
      public process: string,
      public args: string[],
      public options: unknown,
    ) {}
  },
  Task: class {
    constructor(
      public definition: unknown,
      public scope: unknown,
      public name: string,
      public source: string,
      public execution: unknown,
    ) {}
  },
  TaskRevealKind: { Always: 1 },
  TaskPanelKind: { Dedicated: 2 },
  workspace: {
    get isTrusted() {
      return host.trusted;
    },
    get workspaceFolders() {
      return [{ uri: uri(host.workspace), name: "fixture", index: 0 }];
    },
    get textDocuments() {
      return host.documents;
    },
    getConfiguration: () => ({ get: () => undefined }),
    onDidSaveTextDocument: (callback: typeof host.saved) => {
      host.saved = callback;
      return { dispose() {} };
    },
    openTextDocument: async (value: ReturnType<typeof uri>) => {
      const existing = host.documents.find(
        (document) => document.uri.fsPath === value.fsPath,
      );
      if (existing) return existing;
      let text = await readFile(value.fsPath, "utf8");
      const document = {
        uri: value,
        isDirty: false,
        getText: () => text,
        positionAt: (offset: number) => offset,
        setText: (value: string) => {
          text = value;
          document.isDirty = true;
        },
        save: async () => {
          await writeFile(value.fsPath, text);
          document.isDirty = false;
          host.saved?.(document);
          return true;
        },
      };
      host.documents.push(document);
      return document;
    },
    applyEdit: host.applyEdit,
  },
  env: {
    get remoteName() {
      return host.remote;
    },
  },
  window: {
    showInputBox: host.input,
    showQuickPick: async () => host.picks.shift(),
    showWarningMessage: async () => host.picks.shift(),
    showOpenDialog: async () => host.picks.shift(),
    showTextDocument: host.open,
    showErrorMessage: vi.fn(),
  },
  tasks: {
    onDidEndTask: (callback: typeof host.taskEnded) => {
      host.taskEnded = callback;
      return { dispose() {} };
    },
    onDidEndTaskProcess: (callback: typeof host.ended) => {
      host.ended = callback;
      return { dispose() {} };
    },
    executeTask: host.execute,
  },
}));
vi.mock("../../src/pi/launcher", async (original) => ({
  ...(await original<object>()),
  resolvePiLaunch: host.launch,
}));
vi.mock("../../src/features/resource-config", async (original) => ({
  ...(await original<object>()),
  agentSkillRoots: async () => [],
}));
import { ResourceService } from "../../src/features/resources";
import { SessionStore } from "../../src/state/session-store";
let root: string;
let service: ResourceService;
let store: SessionStore;
let messages: HostMessage[];
let apply: ReturnType<typeof vi.fn<(workspace: string) => Promise<void>>>;
const state = () =>
  (
    messages.filter((message) => message.type === "resources").at(-1) as {
      state: ResourceSnapshot;
    }
  ).state;
const item = (
  kind: ResourceItem["kind"],
  name: string,
  scope: ResourceItem["scope"] = "project",
) =>
  state().items.find(
    (item) => item.kind === kind && item.name === name && item.scope === scope,
  )!;
async function act(
  operation: ResourceOperation,
  entry?: ResourceItem,
  kind: ResourceItem["kind"] = "mcp",
) {
  await service.handle({
    type: "resourceAction",
    operation,
    scope: entry?.scope ?? "project",
    kind: entry?.kind ?? kind,
    ...(entry ? { id: entry.id } : {}),
  });
}
async function config(scope: "user" | "project", file: string, data: unknown) {
  const destination = join(
    scope === "user" ? join(root, "agent") : join(host.workspace, ".pi"),
    file,
  );
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(data, null, 2));
  return destination;
}
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), "pi manager 中文 "));
  host.workspace = join(root, "project");
  await mkdir(host.workspace);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  host.trusted = true;
  host.remote = undefined;
  host.inputs = [];
  host.input.mockImplementation(async () => host.inputs.shift());
  host.picks = [];
  host.documents = [];
  host.tasks = [];
  host.launch.mockResolvedValue({
    command: process.execPath,
    args: ["C:/PI space/cli.mjs"],
    env: { PATH: "fixture" },
  });
  host.applyEdit.mockImplementation(async (edit) => {
    const document = host.documents.find(
      (document) => document.uri.fsPath === edit.edit.uri.fsPath,
    );
    document.setText(edit.edit.text);
    return true;
  });
  host.execute.mockImplementation(async (task) => {
    const execution = { task, terminate: vi.fn() };
    host.tasks.push(execution);
    return execution;
  });
  store = new SessionStore();
  store.update({ workspace: host.workspace, connection: "connected" });
  messages = [];
  apply = vi.fn(async (_workspace: string) => {});
  service = new ResourceService(
    store,
    (message) => messages.push(message),
    apply,
  );
});
afterEach(async () => {
  service.dispose();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it("lists scopes and project overrides without sending MCP secrets to the webview", async () => {
  await config("user", "mcp.json", {
    mcpServers: {
      docs: {
        url: "https://example.com/mcp?token=secret-url",
        headers: { Authorization: "secret-header" },
        oauth: { clientSecret: "secret-oauth" },
        env: { KEY: "secret-env" },
      },
    },
  });
  await config("project", "mcp.json", {
    mcpServers: { docs: { enabled: false } },
  });
  await service.show();
  expect(item("mcp", "docs", "user").detail).toContain("存在项目覆盖");
  expect(item("mcp", "docs").state).toBe("配置已禁用");
  expect(item("mcp", "docs").detail).toContain("HTTP");
  expect(JSON.stringify(messages)).not.toMatch(
    /secret-(?:url|header|oauth|env)/,
  );
});

it("toggles an MCP project override while preserving unrelated fields", async () => {
  const file = await config("project", "mcp.json", {
    unknown: 123,
    mcpServers: { docs: { enabled: false, custom: { keep: true } } },
  });
  await service.show();
  await act("toggle", item("mcp", "docs"));
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    unknown: 123,
    mcpServers: { docs: { enabled: true, custom: { keep: true } } },
  });
  expect(state().pending).toBe(true);
});

it("rejects stale configurations and dirty editor buffers", async () => {
  const file = await config("project", "mcp.json", {
    mcpServers: { docs: { command: "npx" } },
  });
  await service.show();
  await writeFile(
    file,
    JSON.stringify({ mcpServers: { docs: { command: "uvx" } } }),
  );
  await act("toggle", item("mcp", "docs"));
  expect(state().error).toContain("其他操作修改");
  expect(JSON.parse(await readFile(file, "utf8")).mcpServers.docs.command).toBe(
    "uvx",
  );
  await act("refresh");
  host.documents.push({ uri: uri(file), isDirty: true });
  await act("toggle", item("mcp", "docs"));
  expect(state().error).toContain("未保存修改");
  expect(host.applyEdit).not.toHaveBeenCalled();
});

it("refuses actions from an old list or another workspace", async () => {
  await config("project", "mcp.json", {
    mcpServers: { docs: { command: "npx" } },
  });
  await service.show();
  const previous = item("mcp", "docs");
  await act("refresh");
  await act("toggle", previous);
  expect(state().error).toContain("资源列表已经改变");
  store.update({ workspace: join(root, "other") });
  await act("toggle", item("mcp", "docs"));
  expect(state().error).toContain("工作目录已改变");
  expect(host.applyEdit).not.toHaveBeenCalled();
});

it("keeps malformed config intact and reports it without revealing its contents", async () => {
  const file = await config("project", "mcp.json", {});
  await writeFile(file, '{"secret-private": invalid}');
  await service.show();
  expect(
    state().warnings.some((warning) => warning.includes("JSON 无效")),
  ).toBe(true);
  expect(JSON.stringify(messages)).not.toContain("secret-private");
  expect(await readFile(file, "utf8")).toBe('{"secret-private": invalid}');
});

it("adds a stdio server using separate executable and argv fields", async () => {
  host.inputs = [
    "filesystem",
    "npx",
    '["-y","@example/server","C:/folder with spaces"]',
  ];
  host.picks = [{ label: "stdio" }];
  await service.show();
  await act("addMcp");
  expect(state().error).toBeUndefined();
  const data = JSON.parse(
    await readFile(join(host.workspace, ".pi", "mcp.json"), "utf8"),
  );
  expect(data.mcpServers.filesystem).toEqual({
    command: "npx",
    args: ["-y", "@example/server", "C:/folder with spaces"],
  });
});

it("creates a Skill only in the chosen scope and refuses overwriting it", async () => {
  host.inputs = ["example", "Skill description: 中文"];
  await service.show();
  await act("createSkill", undefined, "skills");
  const file = join(host.workspace, ".pi", "skills", "example", "SKILL.md");
  const text = await readFile(file, "utf8");
  expect(text).toContain('description: "Skill description: 中文"');
  expect(item("skills", "example")).toBeDefined();
  host.inputs = ["example", "changed"];
  await act("createSkill", undefined, "skills");
  expect(state().error).toBeTruthy();
  expect(await readFile(file, "utf8")).toBe(text);
});

it("opens a manifest extension as a file and leaves filtering its entries to PI config", async () => {
  const directory = join(
    host.workspace,
    ".pi",
    "extensions",
    "manifest-extension",
  );
  await mkdir(directory, { recursive: true });
  const manifest = join(directory, "package.json");
  await writeFile(
    manifest,
    JSON.stringify({ pi: { extensions: ["./src/custom.ts"] } }),
  );
  await service.show();
  const entry = item("extensions", "manifest-extension");
  expect(entry.actions).toEqual(["open", "edit"]);
  await act("open", entry);
  expect(state().error).toBeUndefined();
  expect(host.open.mock.calls.at(-1)?.[0].uri.fsPath).toBe(manifest);
});

it("preserves package filters when disabling one resource type", async () => {
  const file = await config("project", "settings.json", {
    packages: [
      {
        source: "npm:@example/tools",
        extensions: ["extensions/*.ts"],
        custom: 42,
      },
    ],
  });
  await service.show();
  host.picks = ["skills", "不加载此类资源"];
  await act("filters", item("packages", "npm:@example/tools"));
  expect(JSON.parse(await readFile(file, "utf8")).packages[0]).toEqual({
    source: "npm:@example/tools",
    extensions: ["extensions/*.ts"],
    skills: [],
    custom: 42,
  });
});

it("uses ProcessExecution with literal arguments and refreshes after CLI completion", async () => {
  await service.show();
  host.inputs = ["npm:@example/tools@1.0.0"];
  await act("install", undefined, "packages");
  const execution = host.tasks[0].task.execution as vscode.ProcessExecution;
  expect(execution.process).toBe(process.execPath);
  expect(execution.args).toEqual([
    "C:/PI space/cli.mjs",
    "install",
    "npm:@example/tools@1.0.0",
    "--local",
  ]);
  expect(execution.options?.cwd).toBe(host.workspace);
  await config("project", "settings.json", {
    packages: ["npm:@example/tools@1.0.0"],
  });
  host.ended?.({ execution: host.tasks[0], exitCode: 0 });
  await vi.waitFor(() =>
    expect(item("packages", "npm:@example/tools@1.0.0")).toBeDefined(),
  );
  expect(state().pending).toBe(true);
});

it("labels MCP diagnosis as independent and allows the task to be terminated on disposal", async () => {
  await service.show();
  await act("diagnose");
  expect(host.tasks[0].task.execution.args).toEqual([
    "C:/PI space/cli.mjs",
    "mcp",
    "list",
  ]);
  expect(state().notice).toContain("独立进程");
  expect(state().canApply).toBe(false);
  service.dispose();
  expect(host.tasks[0].terminate).toHaveBeenCalledOnce();
});

it("blocks reconnect during work or pending queues, then applies to the selected workspace", async () => {
  await service.show();
  store.update({ run: "running" });
  await act("apply");
  expect(apply).not.toHaveBeenCalled();
  store.update({
    run: "idle",
    queues: { steering: [], followUp: ["pending"] },
  });
  await act("apply");
  expect(apply).not.toHaveBeenCalled();
  store.update({ queues: { steering: [], followUp: [] } });
  await act("apply");
  expect(apply).toHaveBeenCalledWith(host.workspace);
});

it("keeps changes saved during reconnect pending for the next apply", async () => {
  const file = await config("project", "settings.json", {});
  await service.show();
  apply.mockImplementationOnce(async () => {
    host.saved?.({ uri: uri(file) });
  });
  await act("apply");
  expect(state().pending).toBe(true);
  expect(state().notice).toContain("仍有");
});

it.each(["disposed", "workspace changed"])(
  "does not create a Skill after a prompt when the service is %s",
  async (change) => {
    await service.show();
    host.input
      .mockResolvedValueOnce("late-skill")
      .mockImplementationOnce(async () => {
        if (change === "disposed") service.dispose();
        else store.update({ workspace: join(root, "other") });
        return "description";
      });
    await act("createSkill", undefined, "skills");
    await expect(
      readFile(join(host.workspace, ".pi", "skills", "late-skill", "SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("does not start a CLI task if the PI workspace changes during launch discovery", async () => {
  await service.show();
  host.launch.mockImplementationOnce(async () => {
    store.update({ workspace: join(root, "other") });
    return { command: process.execPath, args: [], env: {} };
  });
  await act("diagnose");
  expect(host.execute).not.toHaveBeenCalled();
  expect(state().error).toContain("工作目录已改变");
});

it("writes project-only MCP overrides without copying user credentials", async () => {
  const user = await config("user", "mcp.json", {
    mcpServers: {
      docs: {
        url: "https://example.com",
        headers: { Authorization: "secret" },
      },
    },
  });
  await service.show();
  host.picks = ["在本项目禁用"];
  await act("projectOverride", item("mcp", "docs", "user"));
  expect(
    JSON.parse(await readFile(join(host.workspace, ".pi", "mcp.json"), "utf8")),
  ).toEqual({ mcpServers: { docs: { enabled: false } } });
  expect(
    JSON.parse(await readFile(user, "utf8")).mcpServers.docs.headers
      .Authorization,
  ).toBe("secret");
});
it("releases management controls when a CLI task ends without a process exit event", async () => {
  await service.show();
  await act("diagnose");
  expect(state().canApply).toBe(false);
  host.taskEnded?.({ execution: host.tasks[0] });
  await vi.waitFor(() => expect(state().canApply).toBe(true));
  expect(state().notice).toContain("未知");
  host.ended?.({ execution: host.tasks[0], exitCode: 1 });
  expect(state().notice).toContain("未知");
});
it("does not retain a CLI task that finishes before executeTask resolves", async () => {
  await service.show();
  host.execute.mockImplementationOnce(async (task) => {
    const execution = { task, terminate: vi.fn() };
    host.tasks.push(execution);
    host.ended?.({ execution, exitCode: 0 });
    host.taskEnded?.({ execution });
    return execution;
  });
  await act("diagnose");
  expect(state().canApply).toBe(true);
  expect(state().notice).toContain("退出码 0");
});

it("terminates a task that starts after the resource service was disposed", async () => {
  await service.show();
  let complete!: (execution: unknown) => void;
  host.execute.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const running = act("diagnose");
  await vi.waitFor(() => expect(complete).toBeDefined());
  service.dispose();
  const execution = { terminate: vi.fn() };
  complete(execution);
  await running;
  expect(execution.terminate).toHaveBeenCalledOnce();
});

it("does not lose a CLI completion refresh while another operation is busy", async () => {
  await service.show();
  await act("diagnose");
  let finish!: () => void;
  host.open.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const opening = act("openConfig");
  await vi.waitFor(() => expect(finish).toBeDefined());
  await config("project", "settings.json", { packages: ["npm:@example/new"] });
  host.ended?.({ execution: host.tasks[0], exitCode: 0 });
  finish();
  await opening;
  expect(item("packages", "npm:@example/new")).toBeDefined();
});

it("updates apply availability as the live session starts and settles", async () => {
  await service.show();
  expect(state().canApply).toBe(true);
  store.update({ run: "running" });
  expect(state().canApply).toBe(false);
  store.update({ run: "idle" });
  expect(state().canApply).toBe(true);
});
it.each(["remove", "update"] as const)(
  "uses the canonical local package path for %s",
  async (operation) => {
    await config("project", "settings.json", {
      packages: ["../fixture-package"],
    });
    await service.show();
    host.picks = [operation === "remove" ? "移除" : "更新扩展包"];
    await act(operation, item("packages", "../fixture-package"));
    expect(host.tasks[0].task.execution.args).toEqual(
      operation === "remove"
        ? [
            "C:/PI space/cli.mjs",
            "remove",
            join(host.workspace, "fixture-package"),
            "--local",
          ]
        : [
            "C:/PI space/cli.mjs",
            "update",
            "--extension",
            join(host.workspace, "fixture-package"),
          ],
    );
  },
);
it.each(["untrusted", "remote"])(
  "blocks operations in %s workspaces",
  async (mode) => {
    if (mode === "untrusted") host.trusted = false;
    else host.remote = "ssh-remote";
    await service.show();
    expect(messages).toHaveLength(0);
    expect(host.launch).not.toHaveBeenCalled();
  },
);
