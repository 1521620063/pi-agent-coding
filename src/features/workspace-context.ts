import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { AttachmentService } from "./attachments";
import type { SessionStore } from "../state/session-store";

export interface ContextFile {
  id: string;
  label: string;
  description?: string;
  source: "workspace" | "open" | "current";
}
interface Candidate {
  uri: vscode.Uri;
  root: string;
  document?: vscode.TextDocument;
}
const fileLimit = 5 * 1024 * 1024;
const pathKey = (path: string) => {
  const result = resolve(path);
  return process.platform === "win32" ? result.toLowerCase() : result;
};
function isInside(root: string, target: string): boolean {
  const rel = relative(pathKey(root), pathKey(target));
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
function matches(haystack: string, query: string): boolean {
  const text = haystack.toLowerCase();
  const term = query.toLowerCase();
  if (text.includes(term)) return true;
  let offset = 0;
  for (const character of term) {
    offset = text.indexOf(character, offset);
    if (offset < 0) return false;
    offset++;
  }
  return true;
}

export class WorkspaceContextService {
  private candidates = new Map<string, Candidate>();
  private explicit = new Map<string, string>();
  private untitled = new Map<
    string,
    { document: vscode.TextDocument; root: string }
  >();
  constructor(
    private store: SessionStore,
    private attachments: AttachmentService,
  ) {}

  private root(): string {
    if (!vscode.workspace.isTrusted || vscode.env.remoteName)
      throw new Error("请先信任本地工作区。");
    const folders = vscode.workspace.workspaceFolders ?? [];
    const selected = this.store.getSnapshot().workspace;
    const folder = selected
      ? folders.find(
          (item) =>
            item.uri.scheme === "file" &&
            pathKey(item.uri.fsPath) === pathKey(selected),
        )
      : folders.length === 1 && folders[0].uri.scheme === "file"
        ? folders[0]
        : undefined;
    if (!folder) throw new Error("请先连接本地工作区。");
    return folder.uri.fsPath;
  }

  async search(
    query: string,
  ): Promise<{ items: ContextFile[]; truncated: boolean }> {
    const root = this.root();
    const prefix = /^(open|current):/i.exec(query);
    const term = (prefix ? query.slice(prefix[0].length) : query).trim();
    const limitSource = prefix?.[1].toLowerCase();
    const results = new Map<
      string,
      {
        uri: vscode.Uri;
        document?: vscode.TextDocument;
        source: ContextFile["source"];
        label: string;
      }
    >();
    const current = vscode.window.activeTextEditor?.document;
    const addDocument = (
      document: vscode.TextDocument,
      source: "current" | "open",
    ) => {
      if (
        document.uri.scheme !== "untitled" &&
        (document.uri.scheme !== "file" || !isInside(root, document.uri.fsPath))
      )
        return;
      const label =
        document.uri.scheme === "file"
          ? relative(root, document.uri.fsPath).replace(/\\/g, "/")
          : basename(document.fileName);
      if (!matches(label, term)) return;
      const key = document.uri.toString();
      if (!results.has(key))
        results.set(key, { uri: document.uri, document, source, label });
    };
    if (current && limitSource !== "open") addDocument(current, "current");
    if (limitSource !== "current")
      for (const document of vscode.workspace.textDocuments ?? [])
        addDocument(document, "open");
    let truncated = false;
    if (!limitSource) {
      const excludes = new Set(["**/.git/**", "**/node_modules/**"]);
      for (const section of ["files", "search"]) {
        const configured = vscode.workspace
          .getConfiguration(section, vscode.Uri.file(root))
          .get<unknown>("exclude");
        if (
          !configured ||
          typeof configured !== "object" ||
          Array.isArray(configured)
        )
          continue;
        for (const [pattern, value] of Object.entries(configured)) {
          if (value !== true) continue;
          excludes.add(pattern);
          if (!pattern.endsWith("/**")) excludes.add(`${pattern}/**`);
        }
      }
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(vscode.Uri.file(root), "**/*"),
        `{${[...excludes].join(",")}}`,
        2001,
      );
      const targeted =
        files.length > 2000 && term && !/[?*\[\]{}\\]/.test(term)
          ? await vscode.workspace.findFiles(
              new vscode.RelativePattern(vscode.Uri.file(root), `**/*${term}*`),
              `{${[...excludes].join(",")}}`,
              2001,
            )
          : [];
      if (this.root() !== root) throw new Error("工作区已改变，请重新搜索。");
      truncated = files.length > 2000;
      for (const uri of [...targeted.slice(0, 2000), ...files.slice(0, 2000)]) {
        if (uri.scheme !== "file" || !isInside(root, uri.fsPath)) continue;
        const label = relative(root, uri.fsPath).replace(/\\/g, "/");
        if (!matches(label, term) || results.has(uri.toString())) continue;
        results.set(uri.toString(), { uri, source: "workspace", label });
      }
    }
    const values = [...results.values()];
    truncated ||= values.length > 30;
    const items = values.slice(0, 30).map((value): ContextFile => {
      const id = randomUUID();
      this.candidates.set(id, {
        uri: value.uri,
        root,
        document: value.document,
      });
      return { id, label: value.label, source: value.source };
    });
    while (this.candidates.size > 2000)
      this.candidates.delete(this.candidates.keys().next().value!);
    return { items, truncated };
  }

  async attach(id: string): Promise<void> {
    const root = this.root();
    const candidate = this.candidates.get(id);
    if (!candidate || pathKey(candidate.root) !== pathKey(root))
      throw new Error("文件候选已过期，请重新搜索。");
    this.candidates.delete(id);
    if (candidate.uri.scheme === "untitled") {
      const document = vscode.workspace.textDocuments.find(
        (doc) => doc.uri.toString() === candidate.uri.toString(),
      );
      if (!document) throw new Error("文档已关闭，请重新选择。");
      const reference = document.uri.toString();
      this.attachments.addText(
        basename(document.fileName),
        document.getText(),
        reference,
      );
      this.untitled.set(reference, { document, root });
      while (this.untitled.size > 100)
        this.untitled.delete(this.untitled.keys().next().value!);
      return;
    }
    const path = await this.validateWorkspaceFile(root, candidate.uri.fsPath);
    const document = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === candidate.uri.toString(),
    );
    if (document?.isDirty) {
      this.attachments.addText(
        relative(root, candidate.uri.fsPath).replace(/\\/g, "/"),
        document.getText(),
        candidate.uri.fsPath,
      );
    } else {
      await this.attachments.addFile(
        path,
        relative(root, candidate.uri.fsPath).replace(/\\/g, "/"),
      );
    }
  }

  private async validateWorkspaceFile(
    root: string,
    candidate: string,
  ): Promise<string> {
    if (!isInside(root, candidate)) throw new Error("文件不属于当前工作区。");
    const [actualRoot, actual] = await Promise.all([
      realpath(root),
      realpath(candidate),
    ]);
    if (!isInside(actualRoot, actual))
      throw new Error("文件链接指向工作区之外。");
    const info = await stat(actual);
    if (!info.isFile()) throw new Error("请选择文件。");
    if (info.size > fileLimit)
      throw new Error("插件附件限制：每个文件不超过 5 MiB。");
    if (pathKey(this.root()) !== pathKey(root))
      throw new Error("工作区已改变，请重新选择。");
    return actual;
  }

  async attachUris(uris: readonly vscode.Uri[]): Promise<void> {
    const root = this.root();
    for (const uri of uris.slice(0, 100)) {
      if (uri.scheme !== "file") throw new Error("仅支持本地文件。");
      const actual = await realpath(uri.fsPath);
      if (pathKey(this.root()) !== pathKey(root))
        throw new Error("工作区已改变，请重新选择。");
      const document = vscode.workspace.textDocuments.find(
        (doc) => doc.uri.toString() === uri.toString(),
      );
      if (document?.isDirty) {
        const info = await stat(actual);
        if (!info.isFile() || info.size > fileLimit)
          throw new Error("文件不可用或超过插件 5 MiB 限制。");
        this.attachments.addText(
          basename(uri.fsPath),
          document.getText(),
          uri.fsPath,
        );
      } else {
        await this.attachments.addFile(actual, basename(uri.fsPath));
      }
      this.explicit.set(pathKey(actual), pathKey(root));
    }
  }

  async openReference(reference: string): Promise<void> {
    const root = this.root();
    if (!reference || reference.length > 32768 || /[\x00-\x1f]/.test(reference))
      throw new Error("无效的文件引用。");
    const untitled = this.untitled.get(reference);
    if (untitled && pathKey(untitled.root) === pathKey(root)) {
      if (
        !vscode.workspace.textDocuments.some(
          (document) => document.uri.toString() === reference,
        )
      )
        throw new Error("文档已关闭。");
      await vscode.window.showTextDocument(untitled.document);
      return;
    }
    const match =
      /^(.*?)(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?(?:-L\d+(?:C\d+)?)?)$/.exec(
        reference,
      );
    const file = match ? match[1] : reference;
    if (
      /^(?:command|javascript|data|file|https?|vscode):/i.test(reference) ||
      (/^[a-z][a-z0-9+.-]*:/i.test(file) && !/^[a-z]:[\\/]/i.test(file))
    )
      throw new Error("不支持此文件引用。");
    const line = Math.max(1, Number(match?.[2] ?? match?.[4] ?? 1));
    const column = Math.max(1, Number(match?.[3] ?? match?.[5] ?? 1));
    if (
      !Number.isSafeInteger(line) ||
      !Number.isSafeInteger(column) ||
      line > 2_000_000_000 ||
      column > 2_000_000_000
    )
      throw new Error("无效的文件行号。");
    const candidate = isAbsolute(file) ? resolve(file) : resolve(root, file);
    const attachedPaths = new Set(
      this.store.getSnapshot().attachments.flatMap((item) => {
        if (!item.reference) return [];
        const parsed = /^(.*?)(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/.exec(
          item.reference,
        );
        const path = parsed?.[1] ?? item.reference;
        return isAbsolute(path) ? [pathKey(path)] : [];
      }),
    );
    const allowed = (path: string) =>
      this.explicit.get(pathKey(path)) === pathKey(root) ||
      attachedPaths.has(pathKey(path));
    const [actual, actualRoot] = await Promise.all([
      realpath(candidate),
      realpath(root),
    ]);
    // macOS /var and /private/var may name the same selected file. A grant
    // still applies only to that canonical file, never its containing directory.
    if (!isInside(root, candidate) && !allowed(candidate) && !allowed(actual))
      throw new Error("文件不属于当前工作区。");
    if (!isInside(actualRoot, actual) && !allowed(actual))
      throw new Error("文件不属于当前工作区。");
    if (!(await stat(actual)).isFile()) throw new Error("请选择文件。");
    if (pathKey(this.root()) !== pathKey(root))
      throw new Error("工作区已改变，请重新选择。");
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(actual),
    );
    const requested = new vscode.Position(line - 1, column - 1);
    const position =
      typeof document.validatePosition === "function"
        ? document.validatePosition(requested)
        : requested;
    await vscode.window.showTextDocument(document, {
      selection: new vscode.Selection(position, position),
    });
  }

  async attachDiagnostics(): Promise<void> {
    const root = this.root();
    const options: Array<
      vscode.QuickPickItem & { uri: vscode.Uri; diagnostic: vscode.Diagnostic }
    > = [];
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== "file" || !isInside(root, uri.fsPath)) continue;
      for (const diagnostic of diagnostics) {
        options.push({
          label: `${relative(root, uri.fsPath).replace(/\\/g, "/")}:${diagnostic.range.start.line + 1}`,
          description: diagnostic.message.replace(/\s+/g, " ").slice(0, 200),
          uri,
          diagnostic,
        });
        if (options.length >= 500) break;
      }
      if (options.length >= 500) break;
    }
    const selected = await vscode.window.showQuickPick(options, {
      title: "添加诊断到 PI",
      matchOnDescription: true,
    });
    if (!selected) return;
    await this.validateWorkspaceFile(root, selected.uri.fsPath);
    const line = selected.diagnostic.range.start.line + 1;
    const source = selected.diagnostic.source
      ? `${selected.diagnostic.source}: `
      : "";
    this.attachments.addText(
      selected.label,
      `${source}${selected.diagnostic.message}`,
      `${selected.uri.fsPath}:${line}`,
    );
  }
}
