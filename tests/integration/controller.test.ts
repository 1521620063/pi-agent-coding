import { expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { PiController } from '../../src/pi/controller';
import { SessionStore } from '../../src/state/session-store';
it('handshakes in the selected workspace, and closes its child through stdin EOF', async () => {
  const store = new SessionStore();
  const controller = new PiController(store, {executablePath:resolve('tests/fixtures/fake-pi.mjs'),nodePath:process.execPath,shutdownTimeoutMs:1000});
  await controller.connect(pathToFileURL(process.cwd()).href);
  expect(store.getSnapshot().connection).toBe('connected');
  expect(store.getSnapshot().session?.id).toBe('fake-session');
  const pid = controller.pid!; expect(pid).toBeGreaterThan(0);
  await controller.stopAll(); await controller.disconnect();
  expect(store.getSnapshot().connection).toBe('disconnected');
  expect(() => process.kill(pid,0)).toThrow();
});
it('shows startup diagnostics and rejects connection for an invalid executable', async () => {
  const store = new SessionStore(); const controller = new PiController(store,{executablePath:'C:/missing/pi.exe'});
  await expect(controller.connect(pathToFileURL(process.cwd()).href)).rejects.toThrow();
  expect(store.getSnapshot().connection).toBe('error');
  await controller.disconnect();
});
