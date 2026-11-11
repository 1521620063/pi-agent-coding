import * as vscode from 'vscode';
import { SessionStore } from './state/session-store';
import { createSidebarProvider } from './sidebar/provider';
export function activate(context: vscode.ExtensionContext) {
  const store = new SessionStore();
  const output = vscode.window.createOutputChannel('PI');
  const provider = createSidebarProvider(store, async () => {}, context.extensionUri);
  context.subscriptions.push(output, provider, vscode.window.registerWebviewViewProvider('pi.sidebar', provider), vscode.commands.registerCommand('pi.open', () => vscode.commands.executeCommand('pi.sidebar.focus')));
  return { store };
}
