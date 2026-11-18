import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { killTree } from "../../src/pi/process-tree";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
let killer: EventEmitter & { kill: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.useFakeTimers();
  killer = Object.assign(new EventEmitter(), { kill: vi.fn() });
  vi.mocked(spawn)
    .mockReset()
    .mockReturnValue(killer as unknown as ReturnType<typeof spawn>);
});
afterEach(() => vi.useRealTimers());

it.skipIf(process.platform !== "win32")(
  "falls back to killing the owned child when taskkill cannot start",
  async () => {
    const child = { pid: 1234, kill: vi.fn(() => true) };
    const stopping = killTree(child);
    killer.emit("error", new Error("taskkill missing"));
    await stopping;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  },
);

it.skipIf(process.platform !== "win32")(
  "falls back when taskkill exits unsuccessfully and ignores its output",
  async () => {
    const child = { pid: 1234, kill: vi.fn(() => true) };
    const stopping = killTree(child);
    killer.emit("exit", 1);
    await stopping;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      ["/pid", "1234", "/T", "/F"],
      expect.objectContaining({ stdio: "ignore" }),
    );
  },
);

it.skipIf(process.platform !== "win32")(
  "bounds a stalled taskkill and kills the owned child directly",
  async () => {
    const child = { pid: 1234, kill: vi.fn(() => true) };
    const stopping = killTree(child);
    await vi.advanceTimersByTimeAsync(2000);
    await stopping;
    expect(killer.kill).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.skipIf(process.platform !== "win32")(
  "does not fall back after successful tree cleanup",
  async () => {
    const child = { pid: 1234, kill: vi.fn(() => true) };
    const stopping = killTree(child);
    killer.emit("exit", 0);
    await stopping;
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);
