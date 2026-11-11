import { StringDecoder } from 'node:string_decoder';
import { parseRecord, type PiRecord } from './protocol';
export class JsonlDecoder {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  push(chunk: Uint8Array): PiRecord[] {
    this.buffer += this.decoder.write(Buffer.from(chunk));
    if (this.buffer.length > 64 * 1024 * 1024) throw new Error('PI record exceeds 64 MiB bridge limit');
    const records: PiRecord[] = [];
    let end: number;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end).replace(/\r$/, ''); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      records.push(parseRecord(JSON.parse(line)));
    }
    return records;
  }
  finish(): PiRecord[] { this.buffer += this.decoder.end(); if (this.buffer.trim()) throw new Error('Incomplete PI JSONL record'); return []; }
}
