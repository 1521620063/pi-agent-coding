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
  vscode.Disposable & {
    post(message: HostMessage): void;
    readonly isVisible: boolean;
  } {
  let view: vscode.WebviewView | undefined;
  const disposables: vscode.Disposable[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelSnapshot = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const publishSnapshot = (includeHidden = false) => {
    cancelSnapshot();
    if (view && (view.visible || includeHidden))
      return view.webview.postMessage(snapshotMessage(store.getSnapshot()));
  };
  const unsubscribe = store.subscribeChanges((changed) => {
    // Editor revisions are ordered instructions, not replaceable display state.
    // Preserve the existing delivery to resolved hidden views as well.
    if (changed.includes("editorText")) {
      void publishSnapshot(true);
      return;
    }
    if (!view?.visible || timer !== undefined) return;
    // Coalesce presentation only; business subscriptions remain synchronous.
    timer = setTimeout(() => void publishSnapshot(), 16);
  });
  return {
    get isVisible() {
      return view?.visible ?? false;
    },
    resolveWebviewView(current) {
      cancelSnapshot();
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
      current.webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${current.webview.cspSource} data:; style-src ${current.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${uri("theme.css")}"><link rel="stylesheet" href="${uri("styles.css")}"><link rel="stylesheet" href="${uri("webview.css")}"><title>PI</title></head><body><div id="app"></div><script nonce="${nonce}" src="${uri("webview.js")}"></script></body></html>`;
      disposables.push(
        current.webview.onDidReceiveMessage(async (value) => {
          const action = parseClientAction(value);
          if (!action) return;
          if (action.type === "ready") {
            if (view === current) await publishSnapshot();
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
        current.onDidChangeVisibility(() => {
          if (view !== current) return;
          if (current.visible) void publishSnapshot();
          else cancelSnapshot();
        }),
        current.onDidDispose(() => {
          if (view === current) {
            cancelSnapshot();
            view = undefined;
          }
        }),
      );
    },
    post(message) {
      // Keep action acknowledgements after their state changes, as before
      // batching (in particular editor revisions and attachment removal).
      if (timer !== undefined) void publishSnapshot();
      if (view) void view.webview.postMessage(message);
    },
    dispose() {
      cancelSnapshot();
      unsubscribe();
      for (const disposable of disposables) disposable.dispose();
      view = undefined;
    },
  };
}
