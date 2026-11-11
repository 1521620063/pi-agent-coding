import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import {
  parseClientAction,
  snapshotMessage,
  type ClientAction,
  type HostMessage,
} from "../shared/bridge";
import type { SessionStore } from "../state/session-store";
export function createSidebarProvider(
  store: SessionStore,
  onAction: (action: ClientAction) => Promise<void>,
  extensionUri: vscode.Uri,
): vscode.WebviewViewProvider &
  vscode.Disposable & { post(message: HostMessage): void } {
  let view: vscode.WebviewView | undefined;
  const disposables: vscode.Disposable[] = [];
  const unsubscribe = store.subscribe((state) => {
    if (view) void view.webview.postMessage(snapshotMessage(state));
  });
  return {
    resolveWebviewView(current) {
      view = current;
      current.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
      };
      const uri = (file: string) =>
        current.webview.asWebviewUri(
          vscode.Uri.joinPath(extensionUri, "dist", file),
        );
      const nonce = randomBytes(18).toString("base64");
      current.webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${current.webview.cspSource} data:; style-src ${current.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${uri("theme.css")}"><link rel="stylesheet" href="${uri("styles.css")}"><title>PI</title></head><body><div id="app"></div><script nonce="${nonce}" src="${uri("webview.js")}"></script></body></html>`;
      disposables.push(
        current.webview.onDidReceiveMessage(async (value) => {
          const action = parseClientAction(value);
          if (!action) return;
          if (action.type === "ready") {
            await current.webview.postMessage(
              snapshotMessage(store.getSnapshot()),
            );
            return;
          }
          try {
            await onAction(action);
          } catch (error) {
            store.update({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
      disposables.push(
        current.onDidDispose(() => {
          if (view === current) view = undefined;
        }),
      );
    },
    post(message) {
      if (view) void view.webview.postMessage(message);
    },
    dispose() {
      unsubscribe();
      for (const disposable of disposables) disposable.dispose();
      view = undefined;
    },
  };
}
