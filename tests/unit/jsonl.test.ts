import { expect, it } from 'vitest';
import { JsonlDecoder } from '../../src/pi/jsonl';
it('decodes split UTF-8, LF and CRLF without splitting Unicode separators', () => {
  const decoder = new JsonlDecoder();
  const source = Buffer.from(JSON.stringify({ type: 'message', text: '你好\u2028世界\u2029' }) + '\r\n' + '{"type":"agent_settled"}\n');
  const records = [...source].flatMap(byte => decoder.push(Uint8Array.of(byte)));
  expect(records).toEqual([{ type: 'message', text: '你好\u2028世界\u2029' }, { type: 'agent_settled' }]);
});
it('rejects malformed, non-object and unterminated records', () => {
  expect(() => new JsonlDecoder().push(Buffer.from('[]\n'))).toThrow();
  expect(() => new JsonlDecoder().push(Buffer.from('oops\n'))).toThrow();
  const decoder = new JsonlDecoder(); decoder.push(Buffer.from('{"type":"x"}'));
  expect(() => decoder.finish()).toThrow(/incomplete/i);
});
