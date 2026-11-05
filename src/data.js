import { TellerClient } from './teller.js';

const TTL_MS = 60_000;
const PAGE_SIZE = 500;
const toCents = (s) => Math.round(parseFloat(s) * 100);
const fromCents = (c) => Math.round(c) / 100;

function decorate(account, enrollment) {
  const institution = account.institution?.name || enrollment.institution || 'Unknown';
  return {
    id: account.id,
    enrollment_id: account.enrollment_id || enrollment.enrollmentId,
    institution,
    name: account.name,
    type: account.type,
    subtype: account.subtype,
    status: account.status,
    last_four: account.last_four,
    currency: account.currency,
    entity: enrollment.label || null,
    display: `${institution} ${account.name} ••${account.last_four ?? '----'}`,
  };
}

export function normalizeTransaction(t, account) {
  return {
    id: t.id,
    account_id: t.account_id,
    account: account.display,
    account_type: account.type,
    entity: account.entity,
    date: t.date,
    amount: t.amount,
    status: t.status,
    description: t.description,
    counterparty: t.details?.counterparty?.name ?? null,
    category: t.details?.category ?? null,
    type: t.type ?? null,
    running_balance: t.running_balance ?? null,
  };
}

export function sortNewestFirst(txns) {
  return [...txns].sort((a, b) =>
    a.date === b.date ? (a.id < b.id ? 1 : -1) : a.date < b.date ? 1 : -1,
  );
}

export function filterTransactions(txns, f = {}) {
  const words = f.query ? f.query.toLowerCase().split(/\s+/).filter(Boolean) : [];
  return txns.filter((t) => {
    if (f.status && t.status !== f.status) return false;
    if (f.category && (t.category || '').toLowerCase() !== f.category.toLowerCase()) return false;
    const abs = Math.abs(parseFloat(t.amount));
    if (f.min_amount !== undefined && abs < f.min_amount) return false;
    if (f.max_amount !== undefined && abs > f.max_amount) return false;
    if (words.length) {
      const hay = `${t.description} ${t.counterparty || ''}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

const GROUP_KEYS = {
  category: (t) => t.category || 'uncategorized',
  counterparty: (t) => t.counterparty || t.description,
  month: (t) => t.date.slice(0, 7),
  account: (t) => t.account,
  entity: (t) => t.entity || '(unlabeled)',
  status: (t) => t.status,
  type: (t) => t.type || 'unknown',
};
export const GROUP_BY_OPTIONS = Object.keys(GROUP_KEYS);

/**
 * Sums are in the bank's raw sign convention. We deliberately do not flip signs:
 * conventions can differ between account types, so callers get net plus the raw
 * positive and negative totals and must interpret them per account type.
 */
export function summarize(txns, groupBy) {
  const keyFn = GROUP_KEYS[groupBy];
  const groups = new Map();
  for (const t of txns) {
    const key = keyFn(t);
    const g = groups.get(key) || { key, count: 0, net: 0, pos: 0, neg: 0 };
    const c = toCents(t.amount);
    g.count += 1;
    g.net += c;
    if (c >= 0) g.pos += c;
    else g.neg += c;
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({
      [groupBy]: g.key,
      count: g.count,
      net_amount: fromCents(g.net),
      sum_positive: fromCents(g.pos),
      sum_negative: fromCents(g.neg),
    }))
    .sort((a, b) => Math.abs(b.net_amount) - Math.abs(a.net_amount));
}

export class BankData {
  constructor(cfg, store, client = new TellerClient(cfg)) {
    this.cfg = cfg;
    this.store = store;
    this.client = client;
    this.cache = new Map();
  }

  enrollments() {
    return this.store.list(this.cfg.environment);
  }

  invalidate() {
    this.cache.clear();
  }

  _cached(key, fn) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.t < TTL_MS) return hit.p;
    const p = fn();
    this.cache.set(key, { t: Date.now(), p });
    p.catch(() => this.cache.delete(key));
    return p;
  }

  _tokenFor(enrollmentId) {
    return this.enrollments().find((e) => e.enrollmentId === enrollmentId)?.accessToken;
  }

  /** All accounts across every linked bank, plus per-enrollment errors (e.g. a disconnected login). */
  accounts() {
    return this._cached('accounts', async () => {
      const accounts = [];
      const errors = [];
      await Promise.all(
        this.enrollments().map(async (e) => {
          try {
            const list = await this.client.accounts(e.accessToken);
            for (const a of list) accounts.push(decorate(a, e));
          } catch (err) {
            errors.push({
              enrollment_id: e.enrollmentId,
              institution: e.institution,
              entity: e.label || null,
              code: err.code || 'error',
              message: err.message,
            });
          }
        }),
      );
      accounts.sort((a, b) => a.display.localeCompare(b.display));
      return { accounts, errors };
    });
  }

  /** Resolve a selection of accounts by ids and/or entity label. */
  async pick({ account_ids, entity, includeClosed = false } = {}) {
    const { accounts, errors } = await this.accounts();
    let list = accounts;
    if (account_ids && account_ids.length) {
      const missing = account_ids.filter((id) => !accounts.some((a) => a.id === id));
      if (missing.length) {
        throw new Error(
          `Unknown account id(s): ${missing.join(', ')}. Call teller_list_accounts to see valid ids.`,
        );
      }
      list = list.filter((a) => account_ids.includes(a.id));
    }
    if (entity) {
      const want = entity.toLowerCase();
      list = list.filter((a) => (a.entity || '').toLowerCase() === want);
      if (!list.length) {
        throw new Error(
          `No accounts are labeled "${entity}". Use teller_list_enrollments to see labels.`,
        );
      }
    }
    if (!includeClosed) list = list.filter((a) => a.status === 'open');
    return { accounts: list, errors };
  }

  async balances(accounts) {
    const results = [];
    const errors = [];
    await Promise.all(
      accounts.map(async (a) => {
        try {
          const b = await this.client.balances(this._tokenFor(a.enrollment_id), a.id);
          results.push({
            account_id: a.id,
            account: a.display,
            entity: a.entity,
            type: a.type,
            currency: a.currency,
            ledger: b.ledger ?? null,
            available: b.available ?? null,
          });
        } catch (err) {
          errors.push({ account_id: a.id, account: a.display, code: err.code, message: err.message });
        }
      }),
    );
    results.sort((x, y) => x.account.localeCompare(y.account));
    return { balances: results, errors };
  }

  async _fetchAccountTransactions(account, { start_date, end_date, max }) {
    const token = this._tokenFor(account.enrollment_id);
    const seen = new Set();
    const out = [];
    let fromId;
    while (out.length < max) {
      const page = await this.client.transactionsPage(token, account.id, {
        count: PAGE_SIZE,
        from_id: fromId,
        start_date,
        end_date,
      });
      let fresh = 0;
      for (const t of page) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          out.push(t);
          fresh += 1;
        }
      }
      // Teller returns newest first; the last item is the oldest, so page backward from it.
      if (page.length < PAGE_SIZE || fresh === 0) break;
      fromId = page[page.length - 1].id;
    }
    return { rows: out.slice(0, max), truncated: out.length >= max };
  }

  /** Normalized transactions for the given accounts and date window. */
  async transactions(accounts, { start_date, end_date, max = 5000 }) {
    const txns = [];
    const errors = [];
    const truncated = [];
    await Promise.all(
      accounts.map(async (a) => {
        try {
          const { rows, truncated: cut } = await this._cached(
            `txn|${a.id}|${start_date}|${end_date}|${max}`,
            () => this._fetchAccountTransactions(a, { start_date, end_date, max }),
          );
          for (const t of rows) txns.push(normalizeTransaction(t, a));
          if (cut) truncated.push(a.display);
        } catch (err) {
          errors.push({ account_id: a.id, account: a.display, code: err.code, message: err.message });
        }
      }),
    );
    return { transactions: sortNewestFirst(txns), errors, truncated };
  }

  async revoke(enrollmentId) {
    const token = this._tokenFor(enrollmentId);
    if (!token) throw new Error(`Unknown enrollment ${enrollmentId}`);
    await this.client.revokeEnrollment(token);
  }
}
