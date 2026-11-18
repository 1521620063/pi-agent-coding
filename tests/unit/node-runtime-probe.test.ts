import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { killTree } from "../../src/pi/process-tree";
import { probeNodeVersion } from "../../src/pi/node-runtime";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../src/pi/process-tree", () => ({ killTree: vi.fn() }));

let child: EventEmitter & {
  stdout: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  pid: number;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(spawn).mockReset();
  vi.mocked(killTree).mockReset().mockResolvedValue();
  child = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
    pid: 1234,
  });
  vi.mocked(spawn).mockReturnValue(
    child as unknown as ReturnType<typeof spawn>,
  );
});
afterEach(() => vi.useRealTimers());

it("probes in the PI working directory so manager shims select the same project version", async () => {
  const env = { PATH: "fixture" };
  const probing = probeNodeVersion("node", env, { cwd: "/project" });
  child.stdout.emit("data", Buffer.from("v22.19.0\r\n"));
  child.emit("close", 0);
  expect(await probing).toBe("v22.19.0");
  expect(spawn).toHaveBeenCalledWith(
    "node",
    ["--version"],
    expect.objectContaining({ env, cwd: "/project", windowsHide: true }),
  );
  expect(vi.getTimerCount()).toBe(0);
});

it("kills a stalled probe tree after the bounded timeout", async () => {
  const result = probeNodeVersion("node", {}).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(3000);
  child.emit("close", null);
  expect(await result).toMatchObject({ message: "Node.js 版本检测超时。" });
  expect(killTree).toHaveBeenCalledWith(child);
  expect(vi.getTimerCount()).toBe(0);
});

it("kills the owned tree on cancellation even if the child exits successfully at the same time", async () => {
  const abort = new AbortController();
  const result = probeNodeVersion("node", {}, { signal: abort.signal }).catch(
    (error: unknown) => error,
  );
  child.stdout.emit("data", Buffer.from("v24.22.3"));
  abort.abort();
  child.emit("close", 0);
  expect(await result).toMatchObject({ message: "Node.js 版本检测已取消。" });
  expect(killTree).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("stops an oversized probe output and clears its timer", async () => {
  const result = probeNodeVersion("node", {}).catch((error: unknown) => error);
  child.stdout.emit("data", Buffer.alloc(1025));
  child.emit("close", null);
  expect(await result).toMatchObject({ message: "Node.js 版本输出无效。" });
  expect(killTree).toHaveBeenCalledWith(child);
  expect(vi.getTimerCount()).toBe(0);
});

it("waits for process-tree cleanup even after the probe closes", async () => {
  let cleaned!: () => void;
  vi.mocked(killTree).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        cleaned = resolve;
      }),
  );
  const abort = new AbortController();
  let settled = false;
  const probing = probeNodeVersion("node", {}, { signal: abort.signal })
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  try {
    abort.abort();
    child.emit("close", 0);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
  } finally {
    cleaned();
    await probing;
  }
});

it("waits for the child to close after tree cleanup finishes", async () => {
  const abort = new AbortController();
  let settled = false;
  const probing = probeNodeVersion("node", {}, { signal: abort.signal })
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  try {
    abort.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
  } finally {
    child.emit("close", null);
    await probing;
  }
});

it("bounds cleanup when an inherited pipe prevents the close event", async () => {
  const abort = new AbortController();
  const result = probeNodeVersion("node", {}, { signal: abort.signal }).catch(
    (error: unknown) => error,
  );
  abort.abort();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toMatchObject({
    message: expect.stringContaining("未在清理后关闭"),
  });
  expect(child.stdout.destroy).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("reports cleanup failure without leaving a pending probe", async () => {
  vi.mocked(killTree).mockRejectedValue(new Error("cleanup failed"));
  const abort = new AbortController();
  const probing = probeNodeVersion("node", {}, { signal: abort.signal });
  abort.abort();
  await expect(probing).rejects.toThrow("无法清理");
  expect(vi.getTimerCount()).toBe(0);
});

it("settles spawn errors without leaving a timer", async () => {
  const probing = probeNodeVersion("node", {});
  child.emit("error", new Error("not executable"));
  await expect(probing).rejects.toThrow("not executable");
  expect(vi.getTimerCount()).toBe(0);
});
