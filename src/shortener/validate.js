import net from 'node:net';

const MAX_URL_LENGTH = 2048;
const ALIAS_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;
const RESERVED_ALIASES = new Set(['api', 'health']);

// Blocks loopback / private targets so the service can't be used to point people at internal hosts.
function isPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;

  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (net.isIPv6(host)) {
    return host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
  }
  return false;
}

export function validateUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    return { ok: false, error: `url must be a string of up to ${MAX_URL_LENGTH} characters` };
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: 'url is not valid' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'only http and https urls are allowed' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'urls with embedded credentials are not allowed' };
  }
  if (isPrivateHost(parsed.hostname)) {
    return { ok: false, error: 'private and loopback hosts are not allowed' };
  }
  return { ok: true, url: parsed.toString() };
}

export function validateAlias(alias) {
  if (typeof alias !== 'string' || !ALIAS_PATTERN.test(alias)) {
    return { ok: false, error: 'alias must be 3-32 characters: letters, numbers, - or _' };
  }
  if (RESERVED_ALIASES.has(alias.toLowerCase())) {
    return { ok: false, error: 'that alias is reserved' };
  }
  return { ok: true };
}
