import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SALT = 'teller-bank-sync/store/v1';

/**
 * Enrollment store. Access tokens live only in this file (directory 0700,
 * file 0600) and are never returned to Claude. If a key is supplied
 * (TELLER_STORE_KEY) the file is encrypted at rest with AES-256-GCM, which is
 * what you want on a hosted disk.
 */
export class Store {
  constructor(dir, { key } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'enrollments.json');
    this.encryptionEnabled = Boolean(key);
    this._key = key ? crypto.scryptSync(key, SALT, 32) : null;
  }

  _encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this._key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return JSON.stringify({
      v: 1,
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    });
  }

  _decrypt(envelope) {
    if (!this._key) {
      throw new Error(
        `${this.file} is encrypted. Set TELLER_STORE_KEY to the key that was used to create it.`,
      );
    }
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this._key,
        Buffer.from(envelope.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error(
        `Could not decrypt ${this.file}. TELLER_STORE_KEY is wrong or the file is damaged.`,
      );
    }
  }

  _readAll() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw new Error(`Cannot read ${this.file}: ${e.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${this.file} is not valid JSON.`);
    }
    if (parsed && !Array.isArray(parsed) && parsed.v === 1 && parsed.data) {
      parsed = JSON.parse(this._decrypt(parsed));
    }
    return Array.isArray(parsed) ? parsed : [];
  }

  _writeAll(list) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const json = JSON.stringify(list, null, 2);
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, this._key ? this._encrypt(json) : json, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Every enrollment, or only those for one environment (tokens only work where they were made). */
  list(environment) {
    const all = this._readAll();
    return environment ? all.filter((e) => e.environment === environment) : all;
  }

  upsert(record) {
    const all = this._readAll();
    const i = all.findIndex(
      (e) => e.enrollmentId === record.enrollmentId && e.environment === record.environment,
    );
    if (i >= 0) {
      // Re-linking an existing enrollment keeps its label unless a new one is given.
      all[i] = { ...all[i], ...record, label: record.label ?? all[i].label ?? null };
    } else {
      all.push(record);
    }
    this._writeAll(all);
    return i >= 0 ? all[i] : record;
  }

  setLabel(environment, enrollmentId, label) {
    const all = this._readAll();
    const e = all.find((x) => x.enrollmentId === enrollmentId && x.environment === environment);
    if (!e) return false;
    e.label = label || null;
    this._writeAll(all);
    return true;
  }

  remove(environment, enrollmentId) {
    const all = this._readAll();
    const next = all.filter(
      (e) => !(e.enrollmentId === enrollmentId && e.environment === environment),
    );
    if (next.length === all.length) return false;
    this._writeAll(next);
    return true;
  }
}
