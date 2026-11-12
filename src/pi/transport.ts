import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { ExtensionUiResponse, PiRecord, RpcCommand } from "./protocol";
import type { Unsubscribe } from "../shared/bridge";
import { JsonlDecoder } from "./jsonl";
export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface RpcTransport {
  request<T = any>(command: RpcCommand, options?: RequestOptions): Promise<T>;
  send(record: ExtensionUiResponse): Promise<void>;
  onRecord(listener: (record: PiRecord) => void): Unsubscribe;
  dispose(): void;
}
export function createRpcTransport(
  { stdin, stdout }: { stdin: Writable; stdout: Readable },
  onFatal?: (error: Error) => void,
): RpcTransport {
  const decoder = new JsonlDecoder();
  const listeners = new Set<(record: PiRecord) => void>();
  const writes = new Set<(error: Error) => void>();
  const pending = new Map<
    string,
    {
      command: string;
      resolve(value: any): void;
      reject(error: Error): void;
      cleanup(): void;
    }
  >();
  let closed = false;
  function close(error = new Error("PI transport closed")) {
    if (closed) return;
    closed = true;
    for (const item of pending.values()) {
      item.cleanup();
      item.reject(error);
    }
    pending.clear();
    for (const reject of writes) reject(error);
    writes.clear();
    stdout.off("data", onData);
    stdout.off("end", onEnd);
    // A buffered write can still emit EPIPE after disposal. Keep error
    // listeners until the corresponding pipe has actually closed.
    listeners.clear();
  }
  function onError(error: Error) {
    if (closed) return;
    close(error);
    onFatal?.(error);
  }
  function onStdoutClose() {
    stdout.off("error", onError);
    stdout.off("close", onStdoutClose);
    onError(new Error("PI transport closed: stdout closed"));
  }
  function onStdinClose() {
    stdin.off("error", onError);
    stdin.off("close", onStdinClose);
    onError(new Error("PI transport closed: stdin closed"));
  }
  function onEnd() {
    try {
      decoder.finish();
      onError(new Error("PI transport closed: stdout EOF"));
    } catch (error) {
      onError(error as Error);
    }
  }
  function onData(chunk: Buffer) {
    let records: PiRecord[];
    try {
      records = decoder.push(chunk);
    } catch (error) {
      onError(error as Error);
      return;
    }
    for (const record of records) {
      if (record.type === "response" && typeof record.id === "string") {
        const item = pending.get(record.id);
        if (item) {
          pending.delete(record.id);
          item.cleanup();
          if (record.command !== item.command)
            item.reject(
              new Error(`PI response command mismatch (${record.id})`),
            );
          else if (record.success) item.resolve(record.data);
          else
            item.reject(
              new Error(
                `PI ${item.command} (${record.id}): ${record.error ?? "request failed"}`,
              ),
            );
        }
      } else
        for (const listener of listeners) {
          try {
            listener(record);
          } catch (error) {
            onError(error instanceof Error ? error : new Error(String(error)));
            return;
          }
        }
    }
  }
  stdout.on("data", onData);
  stdout.on("end", onEnd);
  stdout.on("error", onError);
  stdin.on("error", onError);
  stdout.on("close", onStdoutClose);
  stdin.on("close", onStdinClose);
  async function write(record: PiRecord): Promise<void> {
    if (closed || stdin.destroyed || stdin.writableEnded)
      throw new Error("PI transport closed");
    const data = JSON.stringify(record) + "\n";
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        writes.delete(fail);
        reject(error);
      };
      writes.add(fail);
      try {
        stdin.write(data, (error) => {
          writes.delete(fail);
          error ? reject(error) : resolve();
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  return {
    request<T>(command: RpcCommand, options: RequestOptions = {}): Promise<T> {
      if (closed) return Promise.reject(new Error("PI transport closed"));
      if (options.signal?.aborted)
        return Promise.reject(new Error("PI request aborted"));
      const id = command.id ?? randomUUID();
      if (pending.has(id))
        return Promise.reject(new Error("Duplicate PI request ID"));
      return new Promise<T>((resolve, reject) => {
        const timeoutMs = options.timeoutMs ?? 10000;
        const cancel = (error: Error) => {
          const item = pending.get(id);
          if (item) {
            pending.delete(id);
            item.cleanup();
            reject(error);
          }
        };
        const timer =
          timeoutMs > 0
            ? setTimeout(
                () =>
                  cancel(
                    new Error(
                      `PI ${command.type} timed out; execution may still be active`,
                    ),
                  ),
                timeoutMs,
              )
            : undefined;
        const onAbort = () =>
          cancel(new Error(`PI ${command.type} request aborted`));
        const cleanup = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
        };
        pending.set(id, { command: command.type, resolve, reject, cleanup });
        options.signal?.addEventListener("abort", onAbort, { once: true });
        void write({ ...command, id }).catch((error) => cancel(error));
      });
    },
    send: write,
    onRecord(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      close();
    },
  };
}
