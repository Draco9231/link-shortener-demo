import { createHash } from 'node:crypto';

// Append-only log where each entry carries the hash of the previous one,
// so editing or dropping an entry afterwards is detectable.
export class AuditLog {
  constructor(now = Date.now) {
    this.now = now;
    this.entries = [];
    this.onEntry = null;
  }

  log(type, stage = null, data = {}) {
    const prevHash = this.entries.at(-1)?.hash ?? 'genesis';
    const entry = { seq: this.entries.length + 1, ts: this.now(), type, stage, data, prevHash };
    entry.hash = AuditLog.hash(entry);
    this.entries.push(entry);
    this.onEntry?.(entry);
    return entry;
  }

  static hash({ hash, ...rest }) {
    return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
  }

  verify() {
    let prev = 'genesis';
    for (const e of this.entries) {
      if (e.prevHash !== prev || AuditLog.hash(e) !== e.hash) return false;
      prev = e.hash;
    }
    return true;
  }

  toJsonl() {
    return this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  }
}
