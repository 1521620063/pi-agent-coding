import Mocha from "mocha";
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { assertWorkspace } from "../../src/pi/launcher";
import type { AttachmentService } from "../../src/features/attachments";
import type { PiController } from "../../src/pi/controller";
import type { SessionStore } from "../../src/state/session-store";
import { WorkspaceContextService } from "../../src/features/workspace-context";
import { writeFile } from "node:fs/promises";
import manifest from "../../package.json";
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
        `${manifest.publisher}.${manifest.name}`,
      );
      assert.ok(extension);
      assert.equal(extension.packageJSON.engines.vscode, "^1.106.0");
      assert.equal(
        extension.packageJSON.contributes.viewsContainers.secondarySidebar[0]
          .id,
        "pi",
      );
      assert.equal(
        extension.packageJSON.contributes.viewsContainers.activitybar,
        undefined,
      );
      api = await extension.activate();
    });
    test("automatically connects on activation and opens the secondary sidebar", async () => {
      const deadline = Date.now() + 15000;
      while (
        (api.store.getSnapshot().connection !== "connected" ||
          !api.store.getSnapshot().models.length) &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(api.store.getSnapshot().connection, "connected");
      assert.equal(api.store.getSnapshot().models.length, 1);
      assert.equal(
        api.store.getSnapshot().model?.id,
        "fake",
        "The isolated test must use fake PI",
      );
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes("pi.open"));
      await vscode.commands.executeCommand("pi.open");
      assert.equal(api.store.getSnapshot().connection, "connected");
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
    test("attaches selected Explorer files and opens workspace references at a line", async () => {
      const root = vscode.workspace.workspaceFolders![0].uri;
      const file = vscode.Uri.joinPath(root, "上下文 文件.ts");
      await writeFile(file.fsPath, "first\nsecond\nthird", "utf8");
      await vscode.commands.executeCommand("pi.attachFiles", file, [file]);
      const attachment = api.store.getSnapshot().attachments.at(-1)!;
      assert.ok(attachment.name.includes("上下文"));
      const service = new WorkspaceContextService(api.store, api.attachments);
      await service.openReference("上下文 文件.ts:2:3");
      assert.equal(vscode.window.activeTextEditor?.selection.start.line, 1);
      assert.equal(
        vscode.window.activeTextEditor?.selection.start.character,
        2,
      );
      api.attachments.remove(attachment.id);
    });
    test("selects an unsaved current document with @current and cycles through PI RPC", async () => {
      const doc = await vscode.workspace.openTextDocument({
        content: "未保存上下文",
        language: "plaintext",
      });
      await vscode.window.showTextDocument(doc);
      const service = new WorkspaceContextService(api.store, api.attachments);
      const candidates = await service.search("current:");
      assert.equal(candidates.items.length, 1);
      await service.attach(candidates.items[0].id);
      const attachment = api.store.getSnapshot().attachments.at(-1)!;
      assert.ok(
        (await api.attachments.buildPayload([attachment.id])).text.includes(
          "未保存上下文",
        ),
      );
      await service.openReference(attachment.reference!);
      assert.equal(
        vscode.window.activeTextEditor?.document.uri.toString(),
        doc.uri.toString(),
      );
      await vscode.commands.executeCommand("pi.cycleModel");
      assert.equal(api.store.getSnapshot().model?.id, "fake");
      await vscode.commands.executeCommand("pi.cycleThinking");
      assert.equal(api.store.getSnapshot().thinkingLevel, "off");
      api.attachments.remove(attachment.id);
    });
    test("connects from the sidebar command and preserves state across refocus", async () => {
      await vscode.commands.executeCommand("pi.reconnect");
      assert.equal(api.store.getSnapshot().connection, "connected");
      const id = api.store.getSnapshot().session?.id;
      const pid = api.controller.pid;
      await vscode.commands.executeCommand("workbench.view.explorer");
      await vscode.commands.executeCommand("pi.open");
      assert.equal(api.store.getSnapshot().session?.id, id);
      assert.equal(api.controller.pid, pid);
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
