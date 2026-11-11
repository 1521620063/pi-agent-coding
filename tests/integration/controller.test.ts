import { expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { PiController } from "../../src/pi/controller";
import { SessionStore } from "../../src/state/session-store";
it("terminates a live child after a fatal protocol error and preserves the error", async () => {
  const store = new SessionStore();
  const pi = new PiController(store, {
    executablePath: resolve("tests/fixtures/fake-pi.mjs"),
    nodePath: process.execPath,
    shutdownTimeoutMs: 100,
  });
  await pi.connect(pathToFileURL(process.cwd()).href);
  const pid = pi.pid!;
  try {
    await expect(pi.request({ type: "get_entries" })).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(store.getSnapshot().connection).toBe("error");
  } finally {
    await pi.disconnect();
  }
});
it.skipIf(process.platform !== "win32")(
  "forces shutdown of its owned Windows process tree after the EOF timeout",
  async () => {
    const pi = new PiController(new SessionStore(), {
      executablePath: resolve("tests/fixtures/stubborn-pi.mjs"),
      nodePath: process.execPath,
      shutdownTimeoutMs: 100,
    });
    await pi.connect(pathToFileURL(process.cwd()).href);
    const pid = pi.pid!;
    const state = await pi.request({ type: "get_state" });
    await pi.disconnect();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(() => process.kill(state.childPid, 0)).toThrow();
  },
);
it("cancels a connection while version detection is still running without starting a later RPC process", async () => {
  const store = new SessionStore();
  const pi = new PiController(store, {
    executablePath: resolve("tests/fixtures/slow-pi.mjs"),
    nodePath: process.execPath,
    shutdownTimeoutMs: 50,
  });
  const connecting = pi
    .connect(pathToFileURL(process.cwd()).href)
    .catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await pi.disconnect();
  await connecting;
  expect(store.getSnapshot().connection).toBe("disconnected");
  expect(pi.pid).toBeUndefined();
});
it("handshakes in the selected workspace, and closes its child through stdin EOF", async () => {
  const store = new SessionStore();
  const controller = new PiController(store, {
    executablePath: resolve("tests/fixtures/fake-pi.mjs"),
    nodePath: process.execPath,
    shutdownTimeoutMs: 1000,
  });
  await controller.connect(pathToFileURL(process.cwd()).href);
  expect(store.getSnapshot().connection).toBe("connected");
  expect(store.getSnapshot().session?.id).toBe("fake-session");
  const pid = controller.pid!;
  expect(pid).toBeGreaterThan(0);
  await controller.stopAll();
  store.update({
    retry: { active: true },
    compaction: { active: true },
    queues: { steering: ["old"], followUp: [] },
  });
  await controller.disconnect();
  expect(store.getSnapshot().connection).toBe("disconnected");
  expect(store.getSnapshot().retry.active).not.toBe(true);
  expect(store.getSnapshot().compaction.active).not.toBe(true);
  expect(store.getSnapshot().queues.steering).toEqual([]);
  expect(() => process.kill(pid, 0)).toThrow();
});
it("shows startup diagnostics and rejects connection for an invalid executable", async () => {
  const store = new SessionStore();
  const controller = new PiController(store, {
    executablePath: "C:/missing/pi.exe",
  });
  await expect(
    controller.connect(pathToFileURL(process.cwd()).href),
  ).rejects.toThrow();
  expect(store.getSnapshot().connection).toBe("error");
  await controller.disconnect();
});
