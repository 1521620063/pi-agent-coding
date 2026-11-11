import { expect, it } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { createRpcTransport } from '../../src/pi/transport';
it('correlates out-of-order responses and emits events separately', async () => {
  const stdin = new PassThrough(); const stdout = new PassThrough();
  const sent: any[] = []; stdin.on('data', chunk => sent.push(JSON.parse(chunk.toString())));
  const rpc = createRpcTransport({ stdin, stdout }); const events: string[] = [];
  rpc.onRecord(record => events.push(record.type));
  const first = rpc.request({ type: 'get_state' }); const second = rpc.request({ type: 'get_commands' });
  await new Promise(resolve => setImmediate(resolve));
  stdout.write(JSON.stringify({ type: 'response', id: sent[1].id, command: 'get_commands', success: true, data: 2 }) + '\n');
  stdout.write('{"type":"agent_settled"}\n');
  stdout.write(JSON.stringify({ type: 'response', id: sent[0].id, command: 'get_state', success: true, data: 1 }) + '\n');
  await expect(first).resolves.toBe(1); await expect(second).resolves.toBe(2);
  expect(events).toContain('agent_settled'); rpc.dispose();
});
it('reports PI failures and aborts waiting without replaying the command', async () => {
  const stdin = new PassThrough(); const stdout = new PassThrough();
  stdin.on('data', chunk => { const cmd = JSON.parse(chunk.toString()); stdout.write(JSON.stringify({type:'response', id:cmd.id, command:cmd.type, success:false, error:'denied'}) + '\n'); });
  const rpc = createRpcTransport({stdin,stdout});
  await expect(rpc.request({type:'new_session'})).rejects.toThrow(/denied/);
  rpc.dispose();
});
it('waits for writable completion under backpressure and cleans pending requests on EOF', async () => {
  let complete: ((error?: Error | null) => void) | undefined;
  const stdin = new Writable({ highWaterMark: 1, write(_chunk,_encoding,callback) { complete = callback; } });
  const stdout = new PassThrough(); const rpc = createRpcTransport({stdin,stdout});
  let sent = false; const sending = rpc.send({type:'extension_ui_response', id:'ui', cancelled:true}).then(() => { sent = true; });
  await new Promise(resolve => setImmediate(resolve)); expect(sent).toBe(false); complete!(); await sending; expect(sent).toBe(true);
  const pending = rpc.request({type:'get_state'}); stdout.end(); await expect(pending).rejects.toThrow(/closed/); rpc.dispose();
});
it('rejects failed requests, timeout and pending work on exit', async () => {
  const stdin = new PassThrough(); const stdout = new PassThrough();
  const rpc = createRpcTransport({ stdin, stdout });
  await expect(rpc.request({ type: 'get_state' }, { timeoutMs: 5 })).rejects.toThrow(/timed out/i);
  const pending = rpc.request({ type: 'get_state' }); rpc.dispose();
  await expect(pending).rejects.toThrow(/closed/i);
});
