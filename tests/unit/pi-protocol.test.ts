import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { JsonlDecoder } from "../../src/pi/jsonl";
import { modelPresentation, parseRecord } from "../../src/pi/protocol";
import { createRpcTransport } from "../../src/pi/transport";

describe("PI protocol boundaries", () => {
  it("decodes fragmented UTF-8 with CRLF while preserving Unicode line separators", () => {
    const decoder = new JsonlDecoder();
    const bytes = Buffer.from(
      '{"type":"note","text":"中文\u2028行\u2029尾"}\r\n\n{"type":"agent_settled"}\n',
    );
    const records = [...bytes].flatMap((byte) =>
      decoder.push(Uint8Array.of(byte)),
    );
    expect(records).toEqual([
      { type: "note", text: "中文\u2028行\u2029尾" },
      { type: "agent_settled" },
    ]);
    expect(decoder.finish()).toEqual([]);
  });

  it("rejects incomplete and malformed protocol frames", () => {
    const decoder = new JsonlDecoder();
    decoder.push(Buffer.from('{"type":"note"}'));
    expect(() => decoder.finish()).toThrow("Incomplete");
    expect(() => new JsonlDecoder().push(Buffer.from("not JSON\n"))).toThrow();
    expect(() =>
      parseRecord({ type: "response", command: "get_state", success: "yes" }),
    ).toThrow();
    expect(() =>
      parseRecord({ type: "extension_ui_request", method: "input" }),
    ).toThrow();
  });

  it("keeps credentials and endpoints out of model presentation", () => {
    expect(
      modelPresentation({
        id: "example",
        provider: "local",
        name: "Example",
        input: ["text", "image", null],
        contextWindow: 128000,
        headers: { Authorization: "private" },
        apiKey: "private",
        baseUrl: "private",
      }),
    ).toEqual({
      id: "example",
      provider: "local",
      name: "Example",
      input: ["text", "image"],
      contextWindow: 128000,
    });
  });

  it("correlates out-of-order responses and only forwards events to subscribers", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const rpc = createRpcTransport({ stdin, stdout });
    const events: unknown[] = [];
    rpc.onRecord((event) => events.push(event));
    try {
      const first = rpc.request({ type: "get_state", id: "first" });
      const second = rpc.request({ type: "get_messages", id: "second" });
      stdout.write(
        '{"type":"agent_start"}\n{"type":"response","id":"second","command":"get_messages","success":true,"data":{"messages":[]}}\n',
      );
      stdout.write(
        '{"type":"response","id":"first","command":"get_state","success":true,"data":{"sessionId":"one"}}\n',
      );
      await expect(first).resolves.toEqual({ sessionId: "one" });
      await expect(second).resolves.toEqual({ messages: [] });
      expect(events).toEqual([{ type: "agent_start" }]);
    } finally {
      rpc.dispose();
      stdin.destroy();
      stdout.destroy();
    }
  });

  it("rejects mismatched response commands without resolving the wrong request", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const rpc = createRpcTransport({ stdin, stdout });
    try {
      const result = rpc.request({ type: "get_state", id: "state" });
      stdout.write(
        '{"type":"response","id":"state","command":"abort","success":true}\n',
      );
      await expect(result).rejects.toThrow("mismatch");
    } finally {
      rpc.dispose();
      stdin.destroy();
      stdout.destroy();
    }
  });

  it("settles timed out and aborted requests without replaying them", async () => {
    vi.useFakeTimers();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written: string[] = [];
    stdin.on("data", (data: Buffer) => written.push(data.toString()));
    const rpc = createRpcTransport({ stdin, stdout });
    const signal = new AbortController();
    try {
      const timedOut = rpc
        .request({ type: "get_state" }, { timeoutMs: 20 })
        .catch((error: unknown) => error);
      const aborted = rpc
        .request({ type: "compact" }, { timeoutMs: 0, signal: signal.signal })
        .catch((error: unknown) => error);
      signal.abort();
      await vi.advanceTimersByTimeAsync(20);
      expect(await timedOut).toBeInstanceOf(Error);
      expect(await aborted).toBeInstanceOf(Error);
      expect(written.map((line) => JSON.parse(line).type)).toEqual([
        "get_state",
        "compact",
      ]);
    } finally {
      rpc.dispose();
      stdin.destroy();
      stdout.destroy();
      vi.useRealTimers();
    }
  });
});
