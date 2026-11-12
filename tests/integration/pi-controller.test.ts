import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { PiController } from "../../src/pi/controller";
import { SessionStore } from "../../src/state/session-store";

const resources: { pi: PiController; workspace: string }[] = [];
afterEach(async () => {
  for (const { pi, workspace } of resources.splice(0)) {
    await pi.disconnect();
    await rm(workspace, { recursive: true, force: true });
  }
});

async function fixture(mode: string, log?: (text: string) => void) {
  const workspace = await mkdtemp(join(tmpdir(), "pi 生命周期 "));
  await writeFile(join(workspace, "rpc-fixture-mode"), mode);
  const store = new SessionStore();
  const pi = new PiController(
    store,
    {
      executablePath: resolve("tests/fixtures/rpc-lifecycle.mjs"),
      nodePath: process.execPath,
      trusted: true,
      startupTimeoutMs: 2000,
      shutdownTimeoutMs: 100,
    },
    log,
  );
  resources.push({ pi, workspace });
  return { pi, store, workspace, uri: pathToFileURL(workspace).href };
}

it("rejects startup when a fatal event arrives with the handshake response", async () => {
  const { pi, store, uri } = await fixture("subscriber-failure");
  pi.onRecord(() => {
    throw new Error("subscriber failure");
  });
  await expect(pi.connect(uri)).rejects.toThrow("subscriber failure");
  expect(store.getSnapshot().connection).toBe("error");
  expect(pi.pid).toBeUndefined();
});

it("uses a workspace containing spaces and Chinese, and stops clear_queue before abort", async () => {
  const { pi, store, workspace, uri } = await fixture("normal");
  await pi.connect(uri);
  const pid = pi.pid!;
  const state = await pi.request<{ cwd: string }>({ type: "get_state" });
  expect(state.cwd).toBe(workspace);
  expect(store.getSnapshot().session?.id).toBe("lifecycle-fixture");
  await pi.stopAll();
  const result = await pi.request<{ order: string[] }>({ type: "order" });
  expect(result.order.slice(-3)).toEqual(["clear_queue", "abort", "order"]);
  await pi.disconnect();
  expect(store.getSnapshot().connection).toBe("disconnected");
  expect(() => process.kill(pid, 0)).toThrow();
});

it.each(["slow-version", "slow-handshake"])(
  "cancels %s and leaves no late connection",
  async (mode) => {
    let signalReady!: (pid: number) => void;
    const ready = new Promise<number>((resolve) => {
      signalReady = resolve;
    });
    const { pi, store, uri } = await fixture(mode, (text) => {
      const match = /(?:version|handshake)-ready:(\d+)/.exec(text);
      if (match) signalReady(Number(match[1]));
    });
    const connecting = pi.connect(uri).catch((error: unknown) => error);
    const pid = await ready;
    await pi.disconnect();
    expect(await connecting).toBeInstanceOf(Error);
    expect(pi.pid).toBeUndefined();
    expect(store.getSnapshot().connection).toBe("disconnected");
    expect(() => process.kill(pid, 0)).toThrow();
  },
);

it("rejects unbounded requests and cleans its process on protocol corruption", async () => {
  const { pi, store, uri } = await fixture("normal");
  await pi.connect(uri);
  const pid = pi.pid!;
  const pending = pi
    .request({ type: "hold" }, { timeoutMs: 0 })
    .catch((error: unknown) => error);
  await expect(pi.request({ type: "malformed" })).rejects.toThrow();
  expect(await pending).toBeInstanceOf(Error);
  await expect.poll(() => pi.pid).toBeUndefined();
  expect(store.getSnapshot().connection).toBe("error");
  expect(() => process.kill(pid, 0)).toThrow();
});

it.skipIf(process.platform !== "win32")(
  "terminates its stubborn Windows child and descendant",
  async () => {
    const { pi, uri } = await fixture("stubborn");
    await pi.connect(uri);
    const pid = pi.pid!;
    const state = await pi.request<{ childPid: number }>({ type: "get_state" });
    await pi.disconnect();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(() => process.kill(state.childPid, 0)).toThrow();
  },
);
