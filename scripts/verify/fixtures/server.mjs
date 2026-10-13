// Tiny static fixture server for verification runs.
// Binds 127.0.0.1 on a free port. Pages are reachable through two distinct hosts:
// http://127.0.0.1:<port>/ and http://localhost:<port>/ (same server).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// One second of a 440 Hz sine tone, 16-bit mono PCM WAV. Loops cleanly (whole number of cycles).
function toneWav() {
  const rate = 22050;
  const samples = rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.3 * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const TONE = toneWav();

/**
 * Start the fixture server.
 * @returns {Promise<{ port: number, url: string, altUrl: string, close: () => Promise<void> }>}
 *   url uses host 127.0.0.1, altUrl uses host localhost; both end with "/".
 */
export async function startFixtureServer() {
  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1');
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    try {
      if (reqUrl.pathname === '/' || reqUrl.pathname === '/page.html') {
        const html = await readFile(path.join(here, 'page.html'), 'utf8');
        const title = escapeHtml(reqUrl.searchParams.get('t') || 'Fixture page');
        return send(200, 'text/html; charset=utf-8', html.replaceAll('{{TITLE}}', title));
      }
      if (reqUrl.pathname === '/audio.html') {
        const html = await readFile(path.join(here, 'audio.html'), 'utf8');
        const title = escapeHtml(reqUrl.searchParams.get('t') || 'Audio fixture');
        return send(200, 'text/html; charset=utf-8', html.replaceAll('{{TITLE}}', title));
      }
      if (reqUrl.pathname === '/tone.wav') return send(200, 'audio/wav', TONE);
      if (reqUrl.pathname === '/favicon.ico') return send(204, 'text/plain', '');
      return send(404, 'text/plain', 'not found');
    } catch (err) {
      return send(500, 'text/plain', String(err));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    altUrl: `http://localhost:${port}/`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
