import { once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createRpcTransport } from "../../src/pi/transport";

describe("RPC transport lifecycle", () => {
  it("absorbs late pipe errors after deliberate disposal", () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const fatal = vi.fn();
    const rpc = createRpcTransport({ stdin, stdout }, fatal);
    rpc.dispose();
    try {
      expect(() => stdin.emit("error", new Error("write EPIPE"))).not.toThrow();
      expect(() =>
        stdout.emit("error", new Error("read ECONNRESET")),
      ).not.toThrow();
      expect(fatal).not.toHaveBeenCalled();
    } finally {
      stdin.destroy();
      stdout.destroy();
    }
  });

  it.each(["stdout", "stdin"] as const)(
    "rejects unbounded requests when %s closes without an error",
    async (side) => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const fatal = vi.fn();
      const rpc = createRpcTransport({ stdin, stdout }, fatal);
      let outcome: unknown;
      const request = rpc
        .request({ type: "compact" }, { timeoutMs: 0 })
        .catch((error: unknown) => {
          outcome = error;
        });
      try {
        const stream = side === "stdout" ? stdout : stdin;
        const closed = once(stream, "close");
        stream.destroy();
        await closed;
        await nextTurn();
        expect(outcome).toBeInstanceOf(Error);
        expect(fatal).toHaveBeenCalledTimes(1);
        await expect(rpc.request({ type: "get_state" })).rejects.toThrow();
      } finally {
        rpc.dispose();
        stdin.destroy();
        stdout.destroy();
        await request;
      }
    },
  );

  it("ends an extension response write that is still waiting when disposed", async () => {
    let complete: ((error?: Error | null) => void) | undefined;
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        complete = callback;
      },
    });
    const stdout = new PassThrough();
    const rpc = createRpcTransport({ stdin, stdout });
    let outcome: unknown;
    const response = rpc
      .send({ type: "extension_ui_response", id: "dialog", cancelled: true })
      .catch((error: unknown) => {
        outcome = error;
      });
    rpc.dispose();
    try {
      await nextTurn();
      expect(outcome).toBeInstanceOf(Error);
    } finally {
      complete?.();
      await response;
      stdin.destroy();
      stdout.destroy();
    }
  });

  it("closes pending requests when a record subscriber fails", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const fatal = vi.fn();
    const rpc = createRpcTransport({ stdin, stdout }, fatal);
    rpc.onRecord(() => {
      throw new Error("consumer failed");
    });
    let outcome: unknown;
    const request = rpc
      .request({ type: "compact" }, { timeoutMs: 0 })
      .catch((error: unknown) => {
        outcome = error;
      });
    try {
      stdout.write('{"type":"agent_start"}\n');
      await nextTurn();
      expect(outcome).toBeInstanceOf(Error);
      expect(fatal).toHaveBeenCalledTimes(1);
    } finally {
      rpc.dispose();
      stdin.destroy();
      stdout.destroy();
      await request;
    }
  });
});
