import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import type * as vscode from "vscode";
import type { Attachment } from "../shared/bridge";
import type { ImageContent } from "../pi/protocol";
import type { SessionStore } from "../state/session-store";
interface StoredAttachment {
  metadata: Attachment;
  text?: string;
  image?: ImageContent;
}
export class AttachmentService {
  private items = new Map<string, StoredAttachment>();
  constructor(
    private store: SessionStore,
    private picker?: () => Promise<string[] | undefined>,
  ) {}
  async fromSelection(editor: vscode.TextEditor): Promise<Attachment> {
    if (!editor) throw new Error("请先选择编辑器中的文本。");
    const text = editor.document.getText(editor.selection);
    if (!text) throw new Error("当前选区为空。");
    const name = `${basename(editor.document.fileName)}:${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`;
    let reference: string | undefined;
    if (editor.document.uri?.scheme === "file") {
      try {
        reference = `${await realpath(editor.document.fileName)}:${editor.selection.start.line + 1}`;
      } catch {
        // Unsaved new files do not have a filesystem path yet.
      }
    }
    return this.addText(name, text, reference);
  }
  async pickFiles(): Promise<Attachment[]> {
    const paths = await this.picker?.();
    const result: Attachment[] = [];
    for (const path of paths ?? []) result.push(await this.addFile(path));
    return result;
  }
  addText(name: string, text: string, reference?: string): Attachment {
    const size = Buffer.byteLength(text);
    if (size > 5 * 1024 * 1024)
      throw new Error("插件附件限制：每个文件不超过 5 MiB。");
    if (text.includes("\0"))
      throw new Error("仅支持 UTF-8 文本或 PNG/JPEG/GIF/WebP 图片。");
    const metadata: Attachment & { reference?: string } = {
      id: randomUUID(),
      name,
      kind: "text",
      size,
      preview: text.slice(0, 300),
      ...(reference ? { reference } : {}),
    };
    return this.add({ metadata, text: `[${name}]\n${text}` });
  }
  async addFile(path: string, name = basename(path)): Promise<Attachment> {
    const actual = await realpath(path);
    const info = await stat(actual);
    if (!info.isFile()) throw new Error("请选择文件。");
    if (info.size > 5 * 1024 * 1024)
      throw new Error("插件附件限制：每个文件不超过 5 MiB。");
    const bytes = await readFile(actual);
    const mime = (
      {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
      } as Record<string, string>
    )[extname(path).toLowerCase()];
    if (mime)
      return this.addImage({ bytes, mimeType: mime, name, reference: actual });
    if (bytes.includes(0))
      throw new Error("仅支持 UTF-8 文本或 PNG/JPEG/GIF/WebP 图片。");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return this.addText(name, text, actual);
  }
  async addImage(input: {
    bytes: Uint8Array;
    mimeType: string;
    name: string;
    reference?: string;
  }): Promise<Attachment> {
    const bytes = Buffer.from(input.bytes);
    const magic = imageMime(bytes);
    if (!magic || magic !== input.mimeType)
      throw new Error("Invalid image: MIME and image signature must agree.");
    if (bytes.length > 5 * 1024 * 1024)
      throw new Error("插件图片限制：每张 5 MiB。");
    const total = [...this.items.values()]
      .filter((item) => item.image)
      .reduce((sum, item) => sum + item.metadata.size, 0);
    if (total + bytes.length > 15 * 1024 * 1024)
      throw new Error("插件图片限制：合计 15 MiB。");
    return this.add({
      metadata: {
        id: randomUUID(),
        name: input.name,
        kind: "image",
        size: bytes.length,
        preview: `${input.mimeType} · ${bytes.length} bytes`,
        ...(input.reference ? { reference: input.reference } : {}),
      },
      image: {
        type: "image",
        mimeType: input.mimeType,
        data: bytes.toString("base64"),
      },
    });
  }
  private add(item: StoredAttachment): Attachment {
    if (this.items.size >= 100) throw new Error("插件限制：最多 100 个附件。");
    this.items.set(item.metadata.id, item);
    this.publish();
    return item.metadata;
  }
  remove(id: string): void {
    this.items.delete(id);
    this.publish();
  }
  async buildPayload(
    ids: string[],
  ): Promise<{ text: string; images: ImageContent[] }> {
    const selected = [...new Set(ids)].map((id) => {
      const item = this.items.get(id);
      if (!item) throw new Error("Unknown attachment; please attach it again.");
      return item;
    });
    const images = selected.flatMap((item) => (item.image ? [item.image] : []));
    if (
      images.length &&
      !this.store.getSnapshot().model?.input?.includes("image")
    )
      throw new Error(
        "Current model does not support images. Switch model or remove image attachments.",
      );
    return {
      text: selected
        .flatMap((item) => (item.text ? [item.text] : []))
        .join("\n\n"),
      images,
    };
  }
  private publish() {
    this.store.update({
      attachments: [...this.items.values()].map((item) => item.metadata),
    });
  }
}
function imageMime(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 24 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  )
    return "image/png";
  if (
    bytes.length > 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return "image/jpeg";
  if (bytes.length >= 13 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6)))
    return "image/gif";
  if (
    bytes.length >= 20 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
}
