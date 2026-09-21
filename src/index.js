import { createApp } from './shortener/server.js';
import { LinkService } from './shortener/service.js';
import { LinkStore } from './shortener/store.js';
import { createLimiter } from './shortener/ratelimit.js';

const port = Number(process.env.PORT ?? 3000);
const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`;
const store = new LinkStore({ file: process.env.DATA_FILE ?? 'data/links.json' });

createApp({
  service: new LinkService({ store }),
  limiter: createLimiter({ limit: Number(process.env.RATE_LIMIT ?? 60) }),
  baseUrl,
}).listen(port, () => console.log(`link shortener listening on ${baseUrl}`));
