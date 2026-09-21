import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LinkService } from '../../src/shortener/service.js';
import { LinkStore } from '../../src/shortener/store.js';
import { createLimiter } from '../../src/shortener/ratelimit.js';

function setup(start = Date.UTC(2026, 0, 1)) {
  const clock = { t: start };
  const service = new LinkService({ store: new LinkStore(), now: () => clock.t });
  return { service, clock };
}

test('creates a link with a generated code', () => {
  const { service } = setup();
  const link = service.create({ url: 'https://example.com' });
  assert.match(link.code, /^[0-9A-Za-z]{7}$/);
  assert.equal(service.resolve(link.code), 'https://example.com/');
});

test('custom alias works and duplicates are rejected with 409', () => {
  const { service } = setup();
  service.create({ url: 'https://example.com', alias: 'docs' });
  assert.throws(() => service.create({ url: 'https://example.org', alias: 'docs' }), { status: 409 });
});

test('ttl must be a sensible whole number', () => {
  const { service } = setup();
  for (const ttlSeconds of [0, -5, 1.5, 'soon', 1e12]) {
    assert.throws(() => service.create({ url: 'https://example.com', ttlSeconds }), { status: 400 });
  }
});

test('expired links return 410 and are not counted', () => {
  const { service, clock } = setup();
  const { code } = service.create({ url: 'https://example.com', ttlSeconds: 60 });
  service.resolve(code);
  clock.t += 61_000;
  assert.throws(() => service.resolve(code), { status: 410 });
  assert.equal(service.stats(code).clicks, 1);
});

test('unknown codes return 404', () => {
  const { service } = setup();
  assert.throws(() => service.resolve('nothere'), { status: 404 });
  assert.throws(() => service.remove('nothere'), { status: 404 });
});

test('analytics count clicks per day', () => {
  const { service, clock } = setup();
  const { code } = service.create({ url: 'https://example.com' });
  service.resolve(code);
  service.resolve(code);
  clock.t += 24 * 3600 * 1000;
  service.resolve(code);
  const stats = service.stats(code);
  assert.equal(stats.clicks, 3);
  assert.deepEqual(stats.clicksByDay, { '2026-01-01': 2, '2026-01-02': 1 });
  assert.equal(stats.lastClickedAt, clock.t);
});

test('store survives a restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'links-')), 'links.json');
  const first = new LinkService({ store: new LinkStore({ file }) });
  const { code } = first.create({ url: 'https://example.com' });
  first.resolve(code);
  const second = new LinkService({ store: new LinkStore({ file }) });
  assert.equal(second.stats(code).clicks, 1);
});

test('rate limiter blocks after the limit and resets after the window', () => {
  const clock = { t: 0 };
  const limiter = createLimiter({ limit: 2, windowMs: 1000, now: () => clock.t });
  assert.equal(limiter.check('a').allowed, true);
  assert.equal(limiter.check('a').allowed, true);
  const blocked = limiter.check('a');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfter, 1);
  assert.equal(limiter.check('b').allowed, true);
  clock.t = 1001;
  assert.equal(limiter.check('a').allowed, true);
});
