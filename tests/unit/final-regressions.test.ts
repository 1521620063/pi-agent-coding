import { expect, it, vi } from "vitest";
import { ExtensionUiManager } from "../../src/features/extension-ui";
import { SessionStore } from "../../src/state/session-store";
import { ActionGate } from "../../src/features/action-gate";
it("allows disconnect to cancel a pending connection while keeping other transitions blocked", async () => {
  const gate = new ActionGate();
  let done!: () => void;
  const connecting = gate.run(
    "connect",
    () =>
      new Promise<void>((resolve) => {
        done = resolve;
      }),
  );
  try {
    await expect(
      gate.run("disconnect", async () => {}),
    ).resolves.toBeUndefined();
    await expect(gate.run("newSession", async () => {})).rejects.toThrow();
  } finally {
    done();
    await connecting;
  }
});
it("does not answer a duplicate extension dialog ID after it has already completed", async () => {
  const send = vi.fn(async () => {});
  const ui = new ExtensionUiManager(new SessionStore(), send);
  const record = {
    type: "extension_ui_request" as const,
    id: "same",
    method: "confirm",
  };
  ui.handle(record);
  await ui.reply("same", { confirmed: true });
  ui.handle(record);
  await ui.reply("same", { confirmed: true });
  expect(send).toHaveBeenCalledTimes(1);
  ui.dispose();
});
it("blocks sends and competing changes during session transitions while keeping stop available", async () => {
  const gate = new ActionGate();
  let done!: () => void;
  const change = gate.run(
    "newSession",
    () =>
      new Promise<void>((resolve) => {
        done = resolve;
      }),
  );
  await expect(gate.run("send", async () => {})).rejects.toThrow(/session/i);
  await expect(gate.run("fork", async () => {})).rejects.toThrow(/session/i);
  await expect(gate.run("stop", async () => {})).resolves.toBeUndefined();
  done();
  await change;
  await expect(gate.run("send", async () => {})).resolves.toBeUndefined();
});
