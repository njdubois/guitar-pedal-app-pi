import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiBaseForRequestHost } from './server-config.js';

const root = fileURLToPath(new URL('../ui/', import.meta.url));
const safeRoot = resolve(root);
const port = Number.parseInt(process.env.PORT || '4173', 10);
const apiPort = Number.parseInt(process.env.PEDAL_API_PORT || '8080', 10);
const apiSameHost = process.env.PEDAL_API_SAME_HOST === '1';
const configuredApiBase = process.env.PEDAL_API_BASE || '';
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

const server = createServer(async (request, response) => {
  const rawPath = new URL(request.url, 'http://localhost').pathname;
  if (rawPath === '/runtime-config.js') {
    let apiBase = configuredApiBase;
    if (!apiBase && apiSameHost) {
      try { apiBase = apiBaseForRequestHost(request.headers.host, apiPort); }
      catch { apiBase = 'http://guitar-pedal.local:8080'; }
    }
    const body = `globalThis.PEDAL_API_BASE = ${JSON.stringify(apiBase)};\n`;
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    }).end(body);
    return;
  }
  const relative = rawPath === '/' ? 'index.html' : normalize(decodeURIComponent(rawPath)).replace(/^[/\\]+/, '');
  const filename = resolve(root, relative);
  if (filename !== safeRoot && !filename.startsWith(`${safeRoot}${sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(filename);
    if (!info.isFile()) throw new Error('not a file');
    response.writeHead(200, {
      'Content-Type': types[extname(filename)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; connect-src http: https:; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    createReadStream(filename).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Pedal controller: http://127.0.0.1:${port}`);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) console.log(`On your Wi-Fi:      http://${address.address}:${port}`);
    }
  }
  console.log('Press Ctrl+C to stop.');
});
