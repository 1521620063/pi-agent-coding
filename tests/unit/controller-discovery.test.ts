import { expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolvePiLaunch } from "../../src/pi/launcher";
import { PiController } from "../../src/pi/controller";
import { SessionStore } from "../../src/state/session-store";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../src/pi/launcher", async (original) => ({
  ...(await original<typeof import("../../src/pi/launcher")>()),
  resolvePiLaunch: vi.fn(),
}));

it("disconnect waits for cancelled Node discovery to finish cleaning up", async () => {
  let entered!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>((resolve) => {
    entered = resolve;
  });
  let cleaned!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    cleaned = resolve;
  });
  vi.mocked(resolvePiLaunch).mockImplementation(
    async (_config, _env, options) => {
      const signal = options!.signal!;
      entered(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      await cleanup;
      signal.throwIfAborted();
      throw new Error("unexpected continuation");
    },
  );
  const store = new SessionStore();
  const controller = new PiController(store, {});
  const connecting = controller
    .connect(pathToFileURL(process.cwd()).href)
    .catch((error: unknown) => error);
  const signal = await started;
  let disconnected = false;
  const disconnecting = controller.disconnect().then(() => {
    disconnected = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(signal.aborted).toBe(true);
    expect(disconnected).toBe(false);
  } finally {
    cleaned();
    await disconnecting;
    await connecting;
  }
  expect(store.getSnapshot().connection).toBe("disconnected");
  expect(spawn).not.toHaveBeenCalled();
});
