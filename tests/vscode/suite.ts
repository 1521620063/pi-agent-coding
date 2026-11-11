import Mocha from "mocha";
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { assertWorkspace } from "../../src/pi/launcher";
import type { AttachmentService } from "../../src/features/attachments";
import type { PiController } from "../../src/pi/controller";
import type { SessionStore } from "../../src/state/session-store";
export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", timeout: 20000, color: false });
  mocha.suite.emit("pre-require", globalThis, "host", mocha);
  suite("PI extension host", () => {
    let api: {
      store: SessionStore;
      controller: PiController;
      attachments: AttachmentService;
    };
    suiteSetup(async () => {
      const extension = vscode.extensions.getExtension(
        "pi-extension.pi-sidebar",
      );
      assert.ok(extension);
      api = await extension.activate();
    });
    test("registers and opens the activity sidebar", async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes("pi.open"));
      await vscode.commands.executeCommand("pi.open");
      assert.equal(api.store.getSnapshot().connection, "disconnected");
    });
    test("reads Chinese selection from an unsaved editor", async () => {
      const doc = await vscode.workspace.openTextDocument({
        content: "第一行\n当前未保存的内容\n第三行",
        language: "plaintext",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(1, 0, 1, 9);
      const attachment = await api.attachments.fromSelection(editor);
      const payload = await api.attachments.buildPayload([attachment.id]);
      assert.ok(payload.text.includes(doc.getText(editor.selection)));
      assert.ok(payload.text.includes("2-2"));
      assert.ok(doc.isUntitled);
      api.attachments.remove(attachment.id);
    });
    test("enforces local trusted workspace boundaries", () => {
      assert.throws(() =>
        assertWorkspace({ trusted: false, uri: "file:///C:/work" }),
      );
      assert.throws(() => assertWorkspace({ trusted: true }));
      assert.throws(() =>
        assertWorkspace({ trusted: true, uri: "vscode-remote://ssh/work" }),
      );
    });
    test("connects from the sidebar command and preserves state across refocus", async () => {
      await vscode.commands.executeCommand("pi.reconnect");
      assert.equal(api.store.getSnapshot().connection, "connected");
      const id = api.store.getSnapshot().session?.id;
      await vscode.commands.executeCommand("workbench.view.explorer");
      await vscode.commands.executeCommand("pi.open");
      assert.equal(api.store.getSnapshot().session?.id, id);
    });
    test("closes its process when disposed", async () => {
      const pid = api.controller.pid;
      assert.ok(pid);
      await api.controller.disconnect();
      assert.equal(api.store.getSnapshot().connection, "disconnected");
      assert.throws(() => process.kill(pid, 0));
    });
    suiteTeardown(async () => {
      await api?.controller.disconnect();
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });
  });
  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) =>
      failures
        ? reject(new Error(`${failures} VS Code tests failed`))
        : resolve(),
    );
  });
}
