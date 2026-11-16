import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const host = vi.hoisted(() => ({
  root: "",
  files: [] as unknown[],
  documents: [] as unknown[],
  active: undefined as unknown,
  trusted: true,
  remote: undefined as string | undefined,
  openTextDocument: vi.fn(),
  showTextDocument: vi.fn(),
  findFiles: vi.fn(),
  chooseDiagnostic: vi.fn(),
  chooseFolder: vi.fn(),
  executeCommand: vi.fn(),
  diagnostics: [] as unknown[],
  searchExcludes: {} as Record<string, boolean>,
  fileExcludes: {} as Record<string, boolean>,
}));
const uri = (path: string) => ({
  scheme: "file",
  fsPath: path,
  toString: () => pathToFileURL(path).href,
});
vi.mock("vscode", () => ({
  RelativePattern: class {
    constructor(
      public base: unknown,
      public pattern: string,
    ) {}
  },
  Uri: { file: (path: string) => uri(path) },
  Position: class {
    constructor(
      public line: number,
      public character: number,
    ) {}
  },
  Selection: class {
    constructor(
      public start: unknown,
      public end: unknown,
    ) {}
  },
  commands: { executeCommand: host.executeCommand },
  window: {
    get activeTextEditor() {
      return host.active;
    },
    showTextDocument: host.showTextDocument,
    showQuickPick: host.chooseDiagnostic,
    showOpenDialog: host.chooseFolder,
  },
  languages: { getDiagnostics: () => host.diagnostics },
  workspace: {
    get isTrusted() {
      return host.trusted;
    },
    get workspaceFolders() {
      return host.root ? [{ uri: uri(host.root) }] : [];
    },
    get textDocuments() {
      return host.documents;
    },
    openTextDocument: host.openTextDocument,
    findFiles: host.findFiles,
    getConfiguration: (section: string) => ({
      get: () =>
        section === "search" ? host.searchExcludes : host.fileExcludes,
    }),
  },
  env: {
    get remoteName() {
      return host.remote;
    },
  },
}));
import { SessionStore } from "../../src/state/session-store";
import { AttachmentService } from "../../src/features/attachments";
import { WorkspaceContextService } from "../../src/features/workspace-context";

let tmp: string;
let root: string;
let store: SessionStore;
let service: WorkspaceContextService;
beforeEach(async () => {
  vi.clearAllMocks();
  tmp = await mkdtemp(join(tmpdir(), "pi-context-"));
  root = join(tmp, "project");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "中文.ts"), "disk content", "utf8");
  host.chooseFolder.mockReset();
  host.root = root;
  host.trusted = true;
  host.remote = undefined;
  host.active = undefined;
  host.documents = [];
  host.diagnostics = [];
  host.searchExcludes = {};
  host.fileExcludes = {};
  host.files = [uri(join(root, "src", "中文.ts"))];
  host.findFiles.mockImplementation(async () => host.files);
  host.openTextDocument.mockImplementation(async (target) => ({
    uri: target,
    fileName: target.fsPath,
    isDirty: false,
    getText: () => "disk content",
  }));
  host.showTextDocument.mockImplementation(async () => ({
    revealRange: vi.fn(),
  }));
  store = new SessionStore();
  store.update({ workspace: root });
  service = new WorkspaceContextService(store, new AttachmentService(store));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

it("lists paths without reading contents and attaches the chosen unsaved document", async () => {
  const document = {
    uri: uri(join(root, "src", "中文.ts")),
    fileName: join(root, "src", "中文.ts"),
    isDirty: true,
    getText: vi.fn(() => "unsaved Chinese 编辑"),
  };
  host.documents = [document];
  host.active = { document };
  const result = await service.search("中文");
  expect(
    result.items.filter((item) => item.label !== "选择文件夹…"),
  ).toHaveLength(1);
  expect(result.items[0].source).toBe("current");
  expect(document.getText).not.toHaveBeenCalled();
  expect(host.openTextDocument).not.toHaveBeenCalled();
  await service.attach(result.items[0].id);
  expect(document.getText).toHaveBeenCalledOnce();
  expect(store.getSnapshot().attachments[0].preview).toBe(
    "unsaved Chinese 编辑",
  );
});

it("lists folders without reading files and attaches a directory reference", async () => {
  const result = await service.search("src");
  const folder = result.items.find((item) => item.label === "src/")!;
  expect(folder.description).toBe("文件夹");
  expect(host.openTextDocument).not.toHaveBeenCalled();
  await service.attach(folder.id);
  const attachment = store.getSnapshot().attachments[0];
  expect(attachment).toMatchObject({
    name: "src/",
    kind: "directory",
    reference: await realpath(join(root, "src")),
  });
  await service.openReference(attachment.reference!);
  expect(host.executeCommand).toHaveBeenCalledWith(
    "revealInExplorer",
    expect.objectContaining({ fsPath: await realpath(join(root, "src")) }),
  );
});

it("selects an empty folder and preserves the draft when the picker is cancelled", async () => {
  await mkdir(join(root, "空目录"));
  const picker = async () =>
    (await service.search("")).items.find(
      (item) => item.label === "选择文件夹…",
    )!.id;
  host.chooseFolder.mockResolvedValueOnce(undefined);
  expect(await service.attach(await picker())).toBe(false);
  expect(store.getSnapshot().attachments).toEqual([]);
  host.chooseFolder.mockResolvedValueOnce([uri(join(root, "空目录"))]);
  await service.attach(await picker());
  expect(store.getSnapshot().attachments[0]).toMatchObject({
    name: "空目录/",
    kind: "directory",
  });
});

it("rejects folders outside the workspace, linked outside it, or selected after a workspace change", async () => {
  const outside = join(tmp, "outside-folder");
  await mkdir(outside);
  await symlink(outside, join(root, "linked-folder"), "junction");
  const picker = async () =>
    (await service.search("")).items.find(
      (item) => item.label === "选择文件夹…",
    )!.id;
  for (const folder of [outside, join(root, "linked-folder")]) {
    host.chooseFolder.mockResolvedValueOnce([uri(folder)]);
    await expect(service.attach(await picker())).rejects.toThrow(/工作区/);
  }
  const id = await picker();
  host.chooseFolder.mockImplementationOnce(async () => {
    host.root = outside;
    store.update({ workspace: outside });
    return [uri(join(root, "src"))];
  });
  await expect(service.attach(id)).rejects.toThrow(/工作区已改变/);
  expect(store.getSnapshot().attachments).toEqual([]);
});

it("does not offer folder selection in document-only searches", async () => {
  for (const query of ["open:", "current:"]) {
    const result = await service.search(query);
    expect(result.items.some((item) => item.label === "选择文件夹…")).toBe(
      false,
    );
  }
});

it("rejects stale candidate ids after the active workspace changes", async () => {
  const id = (await service.search("中文")).items[0].id;
  const other = join(tmp, "other");
  await mkdir(other);
  host.root = other;
  store.update({ workspace: other });
  await expect(service.attach(id)).rejects.toThrow();
  expect(store.getSnapshot().attachments).toEqual([]);
});

it("opens a workspace file at the requested line but rejects traversal and links outside it", async () => {
  await service.openReference("src/中文.ts:3:2");
  expect(host.showTextDocument).toHaveBeenCalledOnce();
  expect(host.openTextDocument.mock.calls[0][0].fsPath).toBe(
    await realpath(join(root, "src", "中文.ts")),
  );
  await writeFile(join(tmp, "secret.txt"), "secret");
  await expect(service.openReference("../secret.txt")).rejects.toThrow();
  await expect(service.openReference("command:run")).rejects.toThrow();
  const outside = join(tmp, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(outside, join(root, "linked"), "junction");
  await expect(service.openReference("linked/secret.txt")).rejects.toThrow();
  expect(host.showTextDocument).toHaveBeenCalledOnce();
});

it("refuses search and attachment in untrusted or remote workspaces", async () => {
  host.trusted = false;
  await expect(service.search("")).rejects.toThrow();
  host.trusted = true;
  host.remote = "ssh-remote";
  await expect(service.search("")).rejects.toThrow();
  expect(host.findFiles).not.toHaveBeenCalled();
});

it("allows an explicitly selected external file and grants only that file for navigation", async () => {
  const external = join(tmp, "selected.txt");
  await writeFile(external, "selected content");
  await service.attachUris([uri(external) as never]);
  expect(store.getSnapshot().attachments).toHaveLength(1);
  await service.openReference(`${external}:1`);
  await expect(service.openReference(join(tmp, "other.txt"))).rejects.toThrow();
});

it("opens an external file explicitly selected with the attachment picker", async () => {
  const external = join(tmp, "picker.txt");
  await writeFile(external, "selected content");
  const attachments = new AttachmentService(store, async () => [external]);
  service = new WorkspaceContextService(store, attachments);
  await attachments.pickFiles();
  await service.openReference(external);
  expect(host.showTextDocument).toHaveBeenCalledOnce();
});

it("finds an exact query beyond the initial bounded file enumeration", async () => {
  host.findFiles.mockImplementation(async (pattern) =>
    pattern.pattern === "**/*"
      ? Array.from({ length: 2001 }, (_, n) => uri(join(root, `file-${n}.ts`)))
      : [uri(join(root, "src", "中文.ts"))],
  );
  const result = await service.search("中文");
  expect(result.truncated).toBe(true);
  expect(result.items.map((item) => item.label)).toContain("src/中文.ts");
});

it("opens a root-level file reference that includes a line number", async () => {
  await writeFile(join(root, "main.ts"), "content");
  await service.openReference("main.ts:2");
  expect(host.openTextDocument.mock.calls[0][0].fsPath).toBe(
    await realpath(join(root, "main.ts")),
  );
});

it("honors configured file and search exclusions when finding candidates", async () => {
  host.searchExcludes = { "**/generated": true };
  host.fileExcludes = { "**/.secret": true };
  await service.search("");
  const exclusion = host.findFiles.mock.calls[0][1];
  expect(exclusion).toContain("**/generated/**");
  expect(exclusion).toContain("**/.secret/**");
  expect(exclusion).toContain("**/node_modules/**");
});

it("attaches only the selected diagnostic, with a navigable line reference", async () => {
  const path = join(root, "src", "中文.ts");
  host.diagnostics = [
    [
      uri(path),
      [
        { message: "first error", source: "ts", range: { start: { line: 4 } } },
        {
          message: "second error",
          source: "ts",
          range: { start: { line: 5 } },
        },
      ],
    ],
  ];
  host.chooseDiagnostic.mockImplementation(async (options) => options[1]);
  await service.attachDiagnostics();
  expect(store.getSnapshot().attachments).toHaveLength(1);
  expect(store.getSnapshot().attachments[0].preview).toContain("second error");
  expect(store.getSnapshot().attachments[0].preview).not.toContain(
    "first error",
  );
});
