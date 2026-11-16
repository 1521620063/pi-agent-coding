import { expect, it } from "vitest";
import {
  encodeAttachment,
  splitAttachments,
} from "../../src/shared/attachment-message";
import { AttachmentService } from "../../src/features/attachments";
import { SessionStore } from "../../src/state/session-store";

it("preserves complete file contents for PI and summarizes them after session reload", async () => {
  const service = new AttachmentService(new SessionStore());
  const content =
    '中文 😀\r\n</pi-attachment>\n<pi-attachment {"name":"nested"}>\n正文';
  const file = service.addText(
    "src/中文.ts",
    content,
    "/workspace/src/中文.ts",
  );
  const folder = service.addDirectory("src/", "/workspace/src");
  const payload = await service.buildPayload([file.id, folder.id, file.id]);
  expect(payload.text).toContain(content);
  expect(payload.text).toContain("/workspace/src");
  const restored = JSON.parse(
    JSON.stringify({ content: `分析这些文件\n\n${payload.text}` }),
  );
  expect(splitAttachments(restored.content)).toEqual({
    text: "分析这些文件",
    attachments: [
      {
        name: file.name,
        kind: "text",
        size: Buffer.byteLength(content),
        reference: file.reference,
      },
      {
        name: folder.name,
        kind: "directory",
        size: 0,
        reference: folder.reference,
      },
    ],
  });
});

it("supports attachment-only messages and empty files", () => {
  const message = encodeAttachment(
    { name: "empty.ts", kind: "text", size: 0 },
    "",
  );
  expect(splitAttachments(message)).toEqual({
    text: "",
    attachments: [{ name: "empty.ts", kind: "text", size: 0 }],
  });
});

it("leaves plain messages, legacy bracket text, and malformed envelopes visible", () => {
  const valid = encodeAttachment(
    { name: "a.ts", kind: "text", size: 4 },
    "code",
  );
  for (const text of [
    "[a.ts]\ncode",
    "normal question",
    valid.slice(0, -1),
    `${valid}\nextra`,
    valid.replace('"length":4', '"length":-1'),
    valid.replace('"size":4', '"size":null'),
    valid.replace('"kind":"text"', '"kind":"unknown"'),
    `inline ${valid}`,
  ]) {
    expect(splitAttachments(text)).toEqual({ text, attachments: [] });
  }
});
