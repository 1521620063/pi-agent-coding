import type { HostMessage } from '../src/shared/bridge';
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const root = document.getElementById('app')!;
root.innerHTML = '<header><strong>π</strong><span>PI</span></header><main><p>连接本机 PI，开始工作。</p></main><footer><button id="connect">连接 PI</button><div id="status">disconnected</div></footer>';
document.getElementById('connect')!.onclick = () => vscode.postMessage({ type: 'connect' });
window.addEventListener('message', ({ data }: MessageEvent<HostMessage>) => { if (data.type === 'snapshot') document.getElementById('status')!.textContent = data.state.connection; });
vscode.postMessage({ type: 'ready' });
