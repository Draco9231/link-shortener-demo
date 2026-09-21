import fs from 'node:fs';
import path from 'node:path';

// In-memory map, optionally mirrored to a JSON file so links survive a restart.
export class LinkStore {
  constructor({ file } = {}) {
    this.file = file ?? null;
    this.links = new Map();
    if (this.file && fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const link of saved) this.links.set(link.code, link);
    }
  }

  has(code) {
    return this.links.has(code);
  }

  get(code) {
    return this.links.get(code) ?? null;
  }

  save(link) {
    this.links.set(link.code, link);
    this.flush();
  }

  delete(code) {
    const existed = this.links.delete(code);
    if (existed) this.flush();
    return existed;
  }

  flush() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.links.values()]));
    fs.renameSync(tmp, this.file); // rename is atomic, so a crash never leaves a half-written file
  }
}
