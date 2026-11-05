import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { loadConfig } from './config.js';
import { Store } from './store.js';
import { TellerError } from './teller.js';
import {
  BankData,
  GROUP_BY_OPTIONS,
  filterTransactions,
  summarize,
} from './data.js';
import { startLink, linkSessionActive } from './link.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const DEFAULT_WINDOW_DAYS = 90;

function dateWindow(start_date, end_date) {
  const end = end_date || new Date().toISOString().slice(0, 10);
  let start = start_date;
  if (!start) {
    const d = new Date(`${end}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - DEFAULT_WINDOW_DAYS);
    start = d.toISOString().slice(0, 10);
  }
  if (start > end) throw new Error('start_date must be on or before end_date');
  return { start_date: start, end_date: end, defaulted: !start_date };
}

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });

function explain(e) {
  if (e instanceof TellerError) {
    if (e.status === 401 || e.status === 403) {
      return `Teller rejected the credentials (${e.code}). The bank login may be disconnected or the client certificate may not match this application. Re-link with teller_start_link (pass repair_enrollment_id to repair an existing one).`;
    }
    if (e.status === 410) {
      return `That account is closed or no longer accessible (${e.code}).`;
    }
    return `Teller error ${e.status || ''} ${e.code}: ${e.message}`.trim();
  }
  return e.message || String(e);
}

const safe = (fn) => async (args) => {
  try {
    return await fn(args || {});
  } catch (e) {
    return fail(explain(e));
  }
};

const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };

export function buildServer({ cfg = loadConfig(), store, bank, startLinkFn } = {}) {
  store = store || new Store(cfg.dataDir, { key: cfg.storeKey });
  bank = bank || new BankData(cfg, store);
  // Local mode starts a 127.0.0.1 page; hosted mode injects a function that returns a public URL.
  startLinkFn = startLinkFn || ((o) => startLink({ cfg, store, ...o }));

  const server = new McpServer({ name: 'teller-bank-sync', version: '0.1.0' });

  const scope = {
    account_ids: z
      .array(z.string())
      .optional()
      .describe('Limit to these account ids (from teller_list_accounts). Default: all open accounts.'),
    entity: z
      .string()
      .optional()
      .describe('Limit to accounts whose bank login carries this label, e.g. an LLC name.'),
    start_date: isoDate
      .optional()
      .describe(`Inclusive start date. Default: ${DEFAULT_WINDOW_DAYS} days before end_date.`),
    end_date: isoDate.optional().describe('Inclusive end date. Default: today.'),
  };

  const filters = {
    query: z
      .string()
      .optional()
      .describe('Words that must all appear in the description or merchant name (case-insensitive).'),
    category: z.string().optional().describe("Teller's category, e.g. dining, groceries, software."),
    status: z.enum(['posted', 'pending']).optional(),
    min_amount: z.number().nonnegative().optional().describe('Minimum absolute amount.'),
    max_amount: z.number().nonnegative().optional().describe('Maximum absolute amount.'),
  };

  server.registerTool(
    'teller_status',
    {
      title: 'Teller connection status',
      description:
        'Shows whether the Teller connection is configured (environment, application id, certificate) and how many bank logins are linked. Call this first when anything seems misconfigured.',
      inputSchema: {},
      annotations: { ...READ, openWorldHint: false },
    },
    safe(async () => {
      const certOk = (p) => {
        try {
          fs.accessSync(p, fs.constants.R_OK);
          return true;
        } catch {
          return false;
        }
      };
      const all = store.list();
      const inEnv = all.filter((e) => e.environment === cfg.environment);
      return ok({
        environment: cfg.environment,
        application_id_set: Boolean(cfg.applicationId),
        certificate_configured: Boolean(cfg.certPath && cfg.keyPath),
        certificate_readable: Boolean(cfg.certPath && cfg.keyPath && certOk(cfg.certPath) && certOk(cfg.keyPath)),
        certificate_required: cfg.environment !== 'sandbox',
        store_encrypted_at_rest: Boolean(store.encryptionEnabled),
        data_dir: cfg.dataDir,
        linked_bank_logins: inEnv.length,
        linked_in_other_environments: all.length - inEnv.length,
        link_session_open: linkSessionActive(),
      });
    }),
  );

  server.registerTool(
    'teller_start_link',
    {
      title: 'Link a bank or card',
      description:
        "Starts a short-lived local web page (127.0.0.1 only) that hosts Teller Connect. Give the returned URL to the user to open in their browser; they sign in to their bank inside Teller's window and pick accounts. The access token is saved on their computer and is never shown to Claude. Pass `label` to tag the login with an entity name such as an LLC. Pass `repair_enrollment_id` to reconnect a login that has disconnected.",
      inputSchema: {
        label: z.string().max(80).optional().describe('Entity or nickname for this bank login, e.g. "Waterbury Home Investors LLC".'),
        repair_enrollment_id: z.string().optional().describe('An existing enrollment id to repair instead of linking a new bank.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ label, repair_enrollment_id }) => {
      const s = await startLinkFn({
        label,
        repairEnrollmentId: repair_enrollment_id,
        onLinked: () => bank.invalidate(),
      });
      return ok({
        open_this_url_in_your_browser: s.url,
        note: `Valid for ${s.expiresInMinutes} minutes or until one bank is linked. Run again to link another.`,
        environment: cfg.environment,
      });
    }),
  );

  server.registerTool(
    'teller_list_enrollments',
    {
      title: 'List linked bank logins',
      description:
        'Lists linked bank logins (enrollments) in the current environment with their institution, label and link date. Tokens are never included.',
      inputSchema: {},
      annotations: { ...READ, openWorldHint: false },
    },
    safe(async () =>
      ok({
        environment: cfg.environment,
        enrollments: store.list(cfg.environment).map((e) => ({
          enrollment_id: e.enrollmentId,
          institution: e.institution,
          label: e.label || null,
          linked_at: e.linkedAt,
        })),
      }),
    ),
  );

  server.registerTool(
    'teller_label_enrollment',
    {
      title: 'Label a bank login',
      description:
        'Sets or clears the entity label on a linked bank login (for example the LLC that owns it) so accounts can be filtered by entity. Changes only local data.',
      inputSchema: {
        enrollment_id: z.string(),
        label: z.string().max(80).describe('New label. Empty string clears it.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ enrollment_id, label }) => {
      if (!store.setLabel(cfg.environment, enrollment_id, label.trim())) {
        return fail(`No linked enrollment ${enrollment_id} in the ${cfg.environment} environment.`);
      }
      bank.invalidate();
      return ok({ enrollment_id, label: label.trim() || null });
    }),
  );

  server.registerTool(
    'teller_remove_enrollment',
    {
      title: 'Remove a linked bank login',
      description:
        "Removes a linked bank login from this computer. With revoke_at_teller=true it also tells Teller to drop access, which stops billing for it. Only use when the user explicitly asks to disconnect a bank; it cannot be undone (they would have to re-link).",
      inputSchema: {
        enrollment_id: z.string(),
        revoke_at_teller: z.boolean().default(false),
        confirm: z.literal(true).describe('Must be true. Only set it after the user has clearly asked to remove this bank login.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ enrollment_id, revoke_at_teller }) => {
      let revoked = false;
      if (revoke_at_teller) {
        await bank.revoke(enrollment_id);
        revoked = true;
      }
      const removed = store.remove(cfg.environment, enrollment_id);
      bank.invalidate();
      if (!removed) return fail(`No linked enrollment ${enrollment_id} in the ${cfg.environment} environment.`);
      return ok({ enrollment_id, removed_locally: true, revoked_at_teller: revoked });
    }),
  );

  server.registerTool(
    'teller_list_accounts',
    {
      title: 'List accounts',
      description:
        'Lists every connected checking, savings and credit card account with its id, institution, type, last four digits and entity label. Also reports any bank login that currently fails (for example a disconnected one).',
      inputSchema: {
        entity: z.string().optional().describe('Only accounts for this label.'),
        include_closed: z.boolean().default(false),
      },
      annotations: READ,
    },
    safe(async ({ entity, include_closed }) => {
      const { accounts, errors } = await bank.pick({ entity, includeClosed: include_closed });
      return ok({ account_count: accounts.length, accounts, problems: errors });
    }),
  );

  server.registerTool(
    'teller_get_balances',
    {
      title: 'Get live balances',
      description:
        'Fetches live ledger and available balances. Balance lookups are billed per call in Teller production, so request only the accounts the user cares about: pass account_ids or entity, or set all=true for every open account.',
      inputSchema: {
        account_ids: z.array(z.string()).optional(),
        entity: z.string().optional(),
        all: z.boolean().default(false),
      },
      annotations: READ,
    },
    safe(async ({ account_ids, entity, all }) => {
      if (!all && !(account_ids && account_ids.length) && !entity) {
        return fail('Pass account_ids, an entity label, or all=true. (Balance calls cost money in production, so Claude should not fetch every account by accident.)');
      }
      const { accounts, errors } = await bank.pick({ account_ids, entity });
      const res = await bank.balances(accounts);
      return ok({ ...res, problems: errors });
    }),
  );

  server.registerTool(
    'teller_get_transactions',
    {
      title: 'Get transactions for one account',
      description:
        'Returns every transaction of one account in a date window, newest first, with date, amount, status (posted or pending), description, merchant, category and type. Amounts keep the bank\'s sign convention; check a known transaction before assuming which sign means money out, especially for credit cards.',
      inputSchema: {
        account_id: z.string(),
        start_date: scope.start_date,
        end_date: scope.end_date,
        status: z.enum(['posted', 'pending']).optional(),
        limit: z.number().int().min(1).max(1000).default(200),
      },
      annotations: READ,
    },
    safe(async ({ account_id, start_date, end_date, status, limit }) => {
      const win = dateWindow(start_date, end_date);
      const { accounts } = await bank.pick({ account_ids: [account_id], includeClosed: true });
      const { transactions, errors } = await bank.transactions(accounts, win);
      if (errors.length) return fail(`${errors[0].account}: ${errors[0].code} ${errors[0].message}`);
      const rows = filterTransactions(transactions, { status });
      return ok({
        account: accounts[0].display,
        date_range: { start: win.start_date, end: win.end_date, start_was_defaulted: win.defaulted },
        total_in_range: rows.length,
        returned: Math.min(rows.length, limit),
        transactions: rows.slice(0, limit),
      });
    }),
  );

  server.registerTool(
    'teller_search_transactions',
    {
      title: 'Search transactions across accounts',
      description:
        'Searches transactions across all (or selected) accounts and banks at once. Filter by merchant/description words, category, status, amount range, date range, account or entity. Returns newest first with the net total of the matches. Use this to answer questions like "what did I spend at Home Depot this quarter" or "show pending charges over $500".',
      inputSchema: {
        ...scope,
        ...filters,
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: READ,
    },
    safe(async (a) => {
      const win = dateWindow(a.start_date, a.end_date);
      const { accounts, errors } = await bank.pick({ account_ids: a.account_ids, entity: a.entity });
      const { transactions, errors: txErrors, truncated } = await bank.transactions(accounts, win);
      const hits = filterTransactions(transactions, a);
      const net = hits.reduce((s, t) => s + Math.round(parseFloat(t.amount) * 100), 0) / 100;
      return ok({
        date_range: { start: win.start_date, end: win.end_date, start_was_defaulted: win.defaulted },
        accounts_searched: accounts.length,
        total_matched: hits.length,
        returned: Math.min(hits.length, a.limit),
        net_amount_of_matches: net,
        transactions: hits.slice(0, a.limit),
        problems: [...errors, ...txErrors],
        truncated_accounts: truncated,
      });
    }),
  );

  server.registerTool(
    'teller_summarize_transactions',
    {
      title: 'Summarize transactions',
      description:
        'Groups matching transactions and totals them, computed exactly in code: by category, counterparty (merchant), month, account, entity, status or type. Each group has a count, the net amount, and the raw positive and negative sums (bank sign convention).',
      inputSchema: {
        ...scope,
        ...filters,
        group_by: z.enum(GROUP_BY_OPTIONS),
        top: z.number().int().min(1).max(200).default(25),
      },
      annotations: READ,
    },
    safe(async (a) => {
      const win = dateWindow(a.start_date, a.end_date);
      const { accounts, errors } = await bank.pick({ account_ids: a.account_ids, entity: a.entity });
      const { transactions, errors: txErrors, truncated } = await bank.transactions(accounts, win);
      const hits = filterTransactions(transactions, a);
      const groups = summarize(hits, a.group_by);
      return ok({
        date_range: { start: win.start_date, end: win.end_date, start_was_defaulted: win.defaulted },
        transactions_counted: hits.length,
        group_by: a.group_by,
        groups_total: groups.length,
        groups: groups.slice(0, a.top),
        problems: [...errors, ...txErrors],
        truncated_accounts: truncated,
      });
    }),
  );

  return server;
}

