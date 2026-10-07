import type { Response } from 'express';

/** Authenticated download with no-store caching and a safe filename. */
export function sendDownload(res: Response, file: { filename: string; contentType: string; body: Buffer }): void {
  const safeName = file.filename.replace(/[^\w.-]/g, '_');
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send(file.body);
}
