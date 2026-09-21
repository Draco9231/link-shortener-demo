import { AppError } from './errors.js';
import { newCode } from './codes.js';
import { validateAlias, validateUrl } from './validate.js';

const MAX_TTL_SECONDS = 60 * 60 * 24 * 365;
const CODE_RETRIES = 5;

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

export class LinkService {
  constructor({ store, now = Date.now }) {
    this.store = store;
    this.now = now;
  }

  create({ url, alias, ttlSeconds } = {}) {
    const checked = validateUrl(url);
    if (!checked.ok) throw new AppError(400, checked.error);

    let expiresAt = null;
    if (ttlSeconds !== undefined) {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
        throw new AppError(400, `ttlSeconds must be a whole number between 1 and ${MAX_TTL_SECONDS}`);
      }
      expiresAt = this.now() + ttlSeconds * 1000;
    }

    let code;
    if (alias !== undefined) {
      const a = validateAlias(alias);
      if (!a.ok) throw new AppError(400, a.error);
      // Expired links keep their alias until deleted; simple and predictable.
      if (this.store.has(alias)) throw new AppError(409, 'that alias is already taken');
      code = alias;
    } else {
      for (let i = 0; i < CODE_RETRIES && !code; i++) {
        const candidate = newCode();
        if (!this.store.has(candidate)) code = candidate;
      }
      if (!code) throw new AppError(503, 'could not generate a free code, please retry');
    }

    const link = {
      code,
      url: checked.url,
      createdAt: this.now(),
      expiresAt,
      clicks: 0,
      lastClickedAt: null,
      clicksByDay: {},
    };
    this.store.save(link);
    return link;
  }

  // Returns the target url and records the click. Expired links answer 410 and are not counted.
  resolve(code) {
    const link = this.#find(code);
    const t = this.now();
    if (link.expiresAt !== null && link.expiresAt <= t) throw new AppError(410, 'this link has expired');
    link.clicks++;
    link.lastClickedAt = t;
    link.clicksByDay[day(t)] = (link.clicksByDay[day(t)] ?? 0) + 1;
    this.store.save(link);
    return link.url;
  }

  stats(code) {
    return this.#find(code);
  }

  remove(code) {
    if (!this.store.delete(code)) throw new AppError(404, 'link not found');
  }

  #find(code) {
    const link = this.store.get(code);
    if (!link) throw new AppError(404, 'link not found');
    return link;
  }
}
