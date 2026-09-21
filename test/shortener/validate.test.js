import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAlias, validateUrl } from '../../src/shortener/validate.js';

test('accepts normal http and https urls', () => {
  assert.equal(validateUrl('https://example.com/a?b=1').ok, true);
  assert.equal(validateUrl('http://example.com').ok, true);
});

test('rejects bad schemes, credentials and junk', () => {
  for (const bad of ['ftp://example.com', 'javascript:alert(1)', 'https://user:pw@example.com', 'nope', '', 42, 'https://' + 'a'.repeat(3000)]) {
    assert.equal(validateUrl(bad).ok, false, String(bad).slice(0, 30));
  }
});

test('rejects loopback and private hosts', () => {
  for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.0.1', '169.254.1.1', '[::1]', 'printer.local']) {
    assert.equal(validateUrl(`http://${host}/x`).ok, false, host);
  }
  assert.equal(validateUrl('http://172.32.0.1').ok, true);
});

test('alias rules', () => {
  assert.equal(validateAlias('my-link_1').ok, true);
  for (const bad of ['ab', 'has space', 'x'.repeat(33), 'api', 'HEALTH', 'no/slash']) {
    assert.equal(validateAlias(bad).ok, false, bad);
  }
});
