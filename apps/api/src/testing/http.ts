import type { Stream } from 'node:stream';

/** supertest parser that keeps binary bodies (XLSX) intact instead of decoding them as text. */
export function binaryParser(res: Stream, callback: (error: Error | null, data: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}
