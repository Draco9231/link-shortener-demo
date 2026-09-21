import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/shortener/server.js';
import { LinkService } from '../../src/shortener/service.js';
import { LinkStore } from '../../src/shortener/store.js';
import { createLimiter } from '../../src/shortener/ratelimit.js';

async function withServer(fn, { limit = 1000 } = {}) {
  const service = new LinkService({ store: new LinkStore() });
  let base = '';
  const server = createApp({ service, limiter: createLimiter({ limit }), baseUrl: 'http://short.test' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const post = (base, body) =>
  fetch(`${base}/api/links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('create, redirect, stats, delete end to end', async () => {
  await withServer(async (base) => {
    const created = await post(base, { url: 'https://example.com/page', alias: 'demo' });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).shortUrl, 'http://short.test/demo');

    const hit = await fetch(`${base}/demo`, { redirect: 'manual' });
    assert.equal(hit.status, 302);
    assert.equal(hit.headers.get('location'), 'https://example.com/page');

    const stats = await (await fetch(`${base}/api/links/demo/stats`)).json();
    assert.equal(stats.clicks, 1);

    assert.equal((await fetch(`${base}/api/links/demo`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${base}/demo`, { redirect: 'manual' })).status, 404);
  });
});

test('bad input gets a 400 with a message', async () => {
  await withServer(async (base) => {
    const res = await post(base, { url: 'http://127.0.0.1/admin' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /private/);

    const junk = await fetch(`${base}/api/links`, { method: 'POST', body: '{nope' });
    assert.equal(junk.status, 400);
  });
});

test('oversized bodies are refused', async () => {
  await withServer(async (base) => {
    const res = await post(base, { url: 'https://example.com', pad: 'x'.repeat(20_000) }).catch(() => null);
    if (res) assert.equal(res.status, 413);
  });
});

test('rate limit returns 429 with Retry-After, health stays open', async () => {
  await withServer(async (base) => {
    await post(base, { url: 'https://example.com' });
    await post(base, { url: 'https://example.com' });
    const blocked = await post(base, { url: 'https://example.com' });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  }, { limit: 2 });
});

test('unknown routes 404', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  });
});
