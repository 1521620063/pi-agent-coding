import type { Attachment } from "./bridge";

export type SentAttachment = Pick<
  Attachment,
  "name" | "kind" | "size" | "reference"
>;
const opening = "<pi-attachment ";
const closing = "\n</pi-attachment>";

// Length framing keeps file contents (including marker-like text) unambiguous.
// The envelope lives in PI's message, so rendering also works after session reload.
export function encodeAttachment(
  metadata: SentAttachment,
  content: string,
): string {
  const { name, kind, size, reference } = metadata;
  return `${opening}${JSON.stringify({ name, kind, size, ...(reference ? { reference } : {}), length: content.length })}>\n${content}${closing}`;
}

export function splitAttachments(text: string): {
  text: string;
  attachments: SentAttachment[];
} {
  const start = text.indexOf(opening);
  const fallback = { text, attachments: [] };
  if (start < 0 || (start > 0 && !text.slice(0, start).endsWith("\n\n")))
    return fallback;
  const attachments: SentAttachment[] = [];
  let offset = start;
  while (offset < text.length && attachments.length < 100) {
    if (!text.startsWith(opening, offset)) return fallback;
    const headerEnd = text.indexOf(">\n", offset + opening.length);
    if (headerEnd < 0 || headerEnd - offset > 65536) return fallback;
    let data: unknown;
    try {
      data = JSON.parse(text.slice(offset + opening.length, headerEnd));
    } catch {
      return fallback;
    }
    if (!data || typeof data !== "object") return fallback;
    const value = data as Record<string, unknown>;
    if (
      typeof value.name !== "string" ||
      value.name.length > 32768 ||
      !["text", "image", "directory"].includes(String(value.kind)) ||
      typeof value.size !== "number" ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0 ||
      typeof value.length !== "number" ||
      !Number.isSafeInteger(value.length) ||
      value.length < 0 ||
      (value.reference !== undefined &&
        (typeof value.reference !== "string" || value.reference.length > 32768))
    )
      return fallback;
    const end = headerEnd + 2 + value.length;
    if (!text.startsWith(closing, end)) return fallback;
    attachments.push({
      name: value.name,
      kind: value.kind as Attachment["kind"],
      size: value.size,
      ...(typeof value.reference === "string"
        ? { reference: value.reference }
        : {}),
    });
    offset = end + closing.length;
    if (offset === text.length)
      return { text: text.slice(0, start).replace(/\n\n$/, ""), attachments };
    if (!text.startsWith("\n\n", offset)) return fallback;
    offset += 2;
  }
  return fallback;
}
