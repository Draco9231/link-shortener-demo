import http from 'node:http';
import { AppError } from './errors.js';

const MAX_BODY_BYTES = 10 * 1024;

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AppError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new AppError(400, 'body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createApp({ service, limiter, baseUrl }) {
  const view = (link) => ({ ...link, shortUrl: `${baseUrl}/${link.code}` });

  return http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://local');

      if (req.method === 'GET' && pathname === '/health') return send(res, 200, { status: 'ok' });

      const verdict = limiter.check(req.socket.remoteAddress ?? 'unknown');
      if (!verdict.allowed) {
        return send(res, 429, { error: 'too many requests' }, { 'Retry-After': String(verdict.retryAfter) });
      }

      if (req.method === 'POST' && pathname === '/api/links') {
        const link = service.create(await readJson(req));
        return send(res, 201, view(link));
      }

      const api = pathname.match(/^\/api\/links\/([^/]+?)(\/stats)?$/);
      if (api) {
        const [, code, stats] = api;
        if (req.method === 'GET' && stats) return send(res, 200, view(service.stats(code)));
        if (req.method === 'DELETE' && !stats) {
          service.remove(code);
          res.writeHead(204).end();
          return;
        }
      }

      const short = pathname.match(/^\/([A-Za-z0-9_-]+)$/);
      if (req.method === 'GET' && short) {
        // 302 (not 301) so browsers keep hitting us and every click is counted.
        res.writeHead(302, { Location: service.resolve(short[1]), 'Cache-Control': 'no-store' }).end();
        return;
      }

      send(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof AppError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'something went wrong' });
    }
  });
}
