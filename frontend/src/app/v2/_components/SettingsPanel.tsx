'use client';

/**
 * SettingsPanel — /v2. One grouped overlay for the header actions: Connections
 * (external services by category) with Setup gates folded in (what's blocking
 * go-live), and Team (operator management, admin only).
 *
 * Live data: `GET /integrations` supplies the services, their connected state
 * and their config hints; the Team tab drives the real `/users` endpoints
 * (create · rename · role · password reset · delete).
 *
 * @module app/v2/_components/SettingsPanel
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { useFocusTrap } from '../_lib/useFocusTrap';
import { BoltIcon, CloseIcon, GoogleGlyph } from './icons';
import {
  authorizeGoogle,
  createUser,
  deleteUser,
  disconnectGoogle,
  getAnalyticsSummary,
  getGoogleResources,
  getGoogleStatus,
  getSearchConsoleSummary,
  listGoogleConnections,
  listUsers,
  resetUserPassword,
  setGoogleResource,
  updateUser,
} from '@/lib/terminal-api';
import type { User } from '@/types/api';
import type {
  GoogleConnectionView,
  GoogleResourcesView,
  GoogleService,
  Integration,
  IntegrationCategory,
  SafeUser,
} from '@/types/terminal';

/**
 * The two Google surfaces are rendered by the dedicated <GoogleConnections>
 * block (an OAuth connect/disconnect flow with a per-project resource picker),
 * not as plain env-var rows — so they are filtered out of the category list.
 * `page.tsx` also excludes them from the header's connected count.
 */
export const HIDDEN_INTEGRATIONS = new Set(['google-analytics', 'google-search-console']);

const CAT_LABEL: Partial<Record<IntegrationCategory, string>> = {
  analytics: 'Analytics · Google',
  'ai-surface': 'AI answer surfaces',
  serp: 'SERP data',
  performance: 'Performance',
  infrastructure: 'Infrastructure',
  monetization: 'Monetization',
  email: 'Email',
};
const CAT_ORDER: IntegrationCategory[] = [
  'analytics',
  'ai-surface',
  'serp',
  'performance',
  'infrastructure',
  'monetization',
  'email',
];

/** Features gated by missing CODE, not just a missing env value (v1 GatesCard). */
const NOT_WIRED = [
  {
    name: 'Google Analytics / Search Console OAuth',
    detail: 'Connect buttons report not-connected — the 3-legged OAuth flow + token storage is not built.',
    ref: 'READINESS §3.1',
  },
  {
    name: 'Redis-backed rate-limit store',
    detail: 'Throttler uses an in-memory store — fine for one instance, wrong for several.',
    ref: '§5.7',
  },
  {
    name: 'Deployment artifacts',
    detail: 'No Dockerfiles, no CI; SQLite is still the datasource (needs Postgres for prod).',
    ref: '§4, §6',
  },
];
const DEV_FLAGS = ['MEASUREMENT_ALLOW_MOCK', 'INTERNAL_LINK_ALLOW_FIXTURE', 'SERP_ALLOW_FIXTURE'];

const ROLES = ['admin', 'technical', 'content', 'viewer'];

/* ── shared bits ─────────────────────────────────────────────────────── */
function Dot({ ok }: { ok: boolean }) {
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ok ? 'bg-accent' : 'bg-faint'}`} />;
}

function IntegrationRow({ i }: { i: Integration }) {
  const ok = i.connected;
  return (
    <li className="rounded-r3 border border-border bg-bg-inset/60 p-2.5 transition-colors hover:border-border-strong">
      <div className="flex items-center gap-2">
        <Dot ok={ok} />
        <span className="text-body font-semibold text-dim">{i.name}</span>
        <span
          className={`ml-auto shrink-0 rounded-full border px-1.5 py-0.5 text-eyebrow font-semibold uppercase tracking-wide2 ${
            ok ? 'border-accent-dim text-accent' : 'border-border text-faint'
          }`}
        >
          {ok ? 'connected' : i.status === 'unavailable' ? 'unavailable' : 'not set'}
        </span>
      </div>
      <p className="mt-1 text-body leading-snug text-faint">{i.detail}</p>
      {i.configHint && (
        <div className="mt-1.5 flex items-center gap-2">
          <code className="rounded-r1 bg-bg-raised px-1.5 py-0.5 text-caption text-dim">{i.configHint}</code>
          {!ok && i.connectUrl && (
            <a
              href={i.connectUrl}
              target="_blank"
              rel="noreferrer"
              className="text-caption font-medium text-accent hover:underline"
            >
              connect ↗
            </a>
          )}
        </div>
      )}
    </li>
  );
}

function GateRow({ tone, title, right, detail }: { tone: 'warn' | 'danger'; title: string; right: string; detail: string }) {
  return (
    <li className="rounded-r2 border border-border/60 bg-bg-inset/60 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone === 'warn' ? 'bg-warn' : 'bg-danger'}`} />
        <span className="text-body font-medium text-dim">{title}</span>
        <span className="ml-auto shrink-0 text-eyebrow text-faint">{right}</span>
      </div>
      <p className="mt-0.5 text-caption leading-snug text-faint">{detail}</p>
    </li>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-1.5 text-eyebrow font-semibold uppercase tracking-eyebrow text-faint">{children}</h3>;
}

/* ── panel ───────────────────────────────────────────────────────────── */
export function SettingsPanel({
  open,
  onClose,
  user,
  integrations,
  activeProject,
  onRecheck,
  onNotify,
}: {
  open: 'connections' | 'users' | null;
  onClose: () => void;
  user: User | null;
  integrations: Integration[];
  /** the project a Google site / property gets mapped to */
  activeProject?: { id: string; domain: string } | null;
  /** re-read `GET /integrations` — useful right after setting an env var */
  onRecheck: () => Promise<void>;
  onNotify: (msg: string, tone?: 'ok' | 'warn') => void;
}) {
  const isAdmin = user?.role === 'admin';
  const [tab, setTab] = useState<'connections' | 'users'>('connections');
  const [ops, setOps] = useState<SafeUser[] | null>(null);
  const [opsErr, setOpsErr] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /* which operator row has an inline flow open, and which one */
  const [editing, setEditing] = useState<{ id: string; kind: 'rename' | 'password' | 'remove' } | null>(null);
  const card = useRef<HTMLDivElement>(null);

  useFocusTrap(open !== null, card);

  /* a tab switch or a close should never leave an inline flow half-open */
  useEffect(() => {
    setEditing(null);
  }, [tab, open]);

  useEffect(() => {
    if (open) setTab(open === 'users' && isAdmin ? 'users' : 'connections');
  }, [open, isAdmin]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const loadOps = useCallback(async () => {
    setOpsErr(null);
    try {
      setOps(await listUsers());
    } catch (err) {
      setOps([]);
      setOpsErr(err instanceof ApiError ? err.message : 'could not load operators');
    }
  }, []);

  /* the roster is admin-only and only worth fetching once the tab is showing */
  useEffect(() => {
    if (open && tab === 'users' && isAdmin && ops === null) void loadOps();
  }, [open, tab, isAdmin, ops, loadOps]);

  if (!open) return null;

  const configurable = integrations.filter(
    (i) => i.category !== 'mode' && !HIDDEN_INTEGRATIONS.has(i.key),
  );
  const connected = configurable.filter((i) => i.connected).length;
  const total = configurable.length;
  const blocked = configurable.filter((i) => !i.connected);
  const modes = integrations.filter((i) => i.category === 'mode');
  const adminCount = (ops ?? []).filter((o) => o.role === 'admin').length;

  const run = async (id: string, label: string, fn: () => Promise<unknown>, reloadOps = true) => {
    setBusy(id);
    try {
      await fn();
      if (reloadOps) await loadOps();
      onNotify(label);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : `${label} failed`, 'warn');
    } finally {
      setBusy(null);
    }
  };

  const setRole = (o: SafeUser, role: string) =>
    run(o.id, 'role updated', () => updateUser(o.id, { role }));

  const rename = (o: SafeUser, name: string) => {
    setEditing(null);
    if (!name.trim() || name.trim() === o.name) return;
    void run(o.id, 'renamed', () => updateUser(o.id, { name: name.trim() }));
  };

  const resetPw = (o: SafeUser, pw: string) => {
    if (pw.length < 12) {
      onNotify('password must be at least 12 characters', 'warn');
      return;
    }
    setEditing(null);
    void run(o.id, 'password reset · sessions revoked', () => resetUserPassword(o.id, pw));
  };

  const remove = (o: SafeUser) => {
    setEditing(null);
    void run(o.id, 'operator removed', () => deleteUser(o.id));
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[7vh]">
      <div className="absolute inset-0 bg-[#1a1712]/40 backdrop-blur-sm" onClick={onClose} aria-hidden />

      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label="Workspace settings"
        className="v2-pop relative flex max-h-[84vh] w-full max-w-xl flex-col overflow-hidden rounded-r4 border border-border bg-bg-raised shadow-e3"
      >
        {/* header */}
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-r2 bg-accent text-bg-raised">
            <BoltIcon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-ui font-semibold tracking-tight2 text-text">Workspace</h2>
            <p className="font-display text-caption text-faint">connections, setup gates &amp; team</p>
          </div>

          {/* segmented tabs */}
          <div className="ml-auto flex rounded-full border border-border bg-bg-inset p-0.5 text-body font-medium">
            <button
              onClick={() => setTab('connections')}
              className={`rounded-full px-3 py-1 transition-colors ${
                tab === 'connections' ? 'bg-bg-raised text-text shadow-sm' : 'text-faint hover:text-dim'
              }`}
            >
              Connections
            </button>
            {isAdmin && (
              <button
                onClick={() => setTab('users')}
                className={`rounded-full px-3 py-1 transition-colors ${
                  tab === 'users' ? 'bg-bg-raised text-text shadow-sm' : 'text-faint hover:text-dim'
                }`}
              >
                Team
              </button>
            )}
          </div>

          <button onClick={onClose} aria-label="Close" className="grid h-7 w-7 shrink-0 place-items-center rounded-r2 text-faint transition-colors hover:bg-bg-inset hover:text-text">
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        {/* body */}
        <div className="no-scrollbar flex-1 overflow-y-auto p-4">
          {tab === 'connections' ? (
            <>
              {/* summary */}
              <div className="mb-4 rounded-r3 border border-border bg-bg-inset/60 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-body font-semibold text-dim">
                    {connected} of {total} connected
                  </span>
                  <span className="flex items-baseline gap-2 text-caption text-faint">
                    {blocked.length} need a key
                    <button
                      onClick={() =>
                        void run('recheck', 'connections re-checked', onRecheck, false)
                      }
                      disabled={busy === 'recheck'}
                      className="font-medium text-accent transition-opacity hover:underline disabled:opacity-50"
                    >
                      {busy === 'recheck' ? 'checking…' : 're-check'}
                    </button>
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-raised">
                  <span
                    className="block h-full rounded-full bg-accent transition-[width] duration-morph"
                    style={{ width: `${total ? (connected / total) * 100 : 0}%` }}
                  />
                </div>
              </div>

              {/* Google — the one connector with a real OAuth action, so it
                  leads rather than sitting in the env-var list below */}
              <GoogleConnections activeProject={activeProject ?? null} onNotify={onNotify} onRecheck={onRecheck} />

              {total === 0 && (
                <p className="text-body text-faint">Integration list unavailable — is the backend reachable?</p>
              )}

              {/* integrations by category (unknown categories fall through last) */}
              {[...CAT_ORDER, ...new Set(configurable.map((i) => i.category).filter((c) => !CAT_ORDER.includes(c)))].map(
                (cat) => {
                  const items = configurable.filter((i) => i.category === cat);
                  if (!items.length) return null;
                  return (
                    <div key={cat} className="mb-4">
                      <Label>{CAT_LABEL[cat] ?? cat}</Label>
                      <ul className="space-y-1.5">
                        {items.map((i) => (
                          <IntegrationRow key={i.key} i={i} />
                        ))}
                      </ul>
                    </div>
                  );
                },
              )}

              {/* setup gates — folded into connections */}
              <div className="mt-5 rounded-r3 border border-warn/40 bg-warn/[0.08] p-3">
                <div className="mb-2 flex items-center gap-1.5">
                  <BoltIcon className="h-3.5 w-3.5 text-warn" />
                  <span className="text-caption font-semibold uppercase tracking-eyebrow text-warn">Setup gates</span>
                </div>

                <Label>Needs a key or credential ({blocked.length})</Label>
                {blocked.length === 0 ? (
                  <p className="mb-3 text-body text-accent">All configurable integrations are connected.</p>
                ) : (
                  <ul className="mb-3 space-y-1">
                    {blocked.map((i) => (
                      <GateRow key={i.key} tone="warn" title={i.name} right={i.configHint} detail={i.detail} />
                    ))}
                  </ul>
                )}

                <Label>Not wired — needs code ({NOT_WIRED.length})</Label>
                <ul className="mb-3 space-y-1">
                  {NOT_WIRED.map((n) => (
                    <GateRow key={n.name} tone="danger" title={n.name} right={n.ref} detail={n.detail} />
                  ))}
                </ul>

                <Label>Modes</Label>
                <ul className="space-y-1 text-caption">
                  {modes.map((m) => (
                    <li key={m.key} className="flex items-center gap-2">
                      <span className={`h-1.5 w-1.5 rounded-full ${m.status === 'enabled' ? 'bg-warn' : 'bg-faint'}`} />
                      <span className="text-dim">{m.name}</span>
                      <span className="ml-auto truncate text-faint">{m.detail}</span>
                    </li>
                  ))}
                  <li className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-warn" />
                    <span className="shrink-0 text-dim">Disable in prod</span>
                    <span className="ml-auto truncate text-faint">{DEV_FLAGS.join(' · ')}</span>
                  </li>
                </ul>
              </div>
            </>
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between">
                <span className="text-body font-semibold text-dim">
                  {ops === null ? 'loading operators…' : `${ops.length} operator${ops.length === 1 ? '' : 's'}`}
                </span>
                <button
                  onClick={() => setShowCreate((s) => !s)}
                  className="rounded-r2 border border-accent-dim bg-accent-dim/14 px-2.5 py-1 text-body font-medium text-accent transition-colors hover:bg-accent-dim/24"
                >
                  {showCreate ? 'close' : '+ new operator'}
                </button>
              </div>

              {opsErr && <p className="mb-3 text-body text-danger">{opsErr}</p>}

              {showCreate && (
                <CreateForm
                  onCreate={async (input) => {
                    await run('new', 'operator created', () => createUser(input));
                    setShowCreate(false);
                  }}
                />
              )}

              {ops === null ? (
                <ul className="space-y-1.5">
                  {Array.from({ length: 3 }, (_, i) => (
                    <li key={i} className="v2skel h-[74px] rounded-r3" />
                  ))}
                </ul>
              ) : (
                <ul className="space-y-1.5">
                  {ops.map((o) => {
                    const isSelf = o.id === user?.id;
                    const lastAdmin = o.role === 'admin' && adminCount === 1;
                    const working = busy === o.id;
                    return (
                      <li
                        key={o.id}
                        className={`rounded-r3 border border-border bg-bg-inset/60 p-2.5 transition-colors hover:border-border-strong ${
                          working ? 'opacity-60' : ''
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-dim/24 text-caption font-semibold text-accent">
                            {o.name.slice(0, 1).toUpperCase()}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 text-body font-semibold text-dim">
                              <span className="truncate">{o.name}</span>
                              {isSelf && <span className="rounded-r1 bg-accent-dim/24 px-1 text-eyebrow uppercase text-accent">you</span>}
                            </div>
                            <div className="truncate text-caption text-faint">{o.email}</div>
                          </div>

                          <select
                            value={o.role}
                            onChange={(e) => void setRole(o, e.target.value)}
                            disabled={lastAdmin || working}
                            className="ml-auto rounded-r2 border border-border bg-bg-raised px-1.5 py-1 text-caption text-dim outline-none disabled:opacity-50"
                          >
                            {ROLES.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        </div>

                        {/* inline flows — these used to be native prompt() and
                            confirm() dialogs, which threw OS chrome into the
                            middle of the console */}
                        {editing?.id === o.id ? (
                          <InlineFlow
                            kind={editing.kind}
                            operator={o}
                            onCancel={() => setEditing(null)}
                            onRename={(v) => rename(o, v)}
                            onPassword={(v) => resetPw(o, v)}
                            onRemove={() => remove(o)}
                          />
                        ) : (
                          <div className="mt-2 flex justify-end gap-1 text-caption">
                            <button
                              onClick={() => setEditing({ id: o.id, kind: 'rename' })}
                              disabled={working}
                              className="rounded-r1 border border-border px-1.5 py-0.5 text-faint transition-colors duration-micro hover:text-dim disabled:opacity-40"
                            >
                              rename
                            </button>
                            <button
                              onClick={() => setEditing({ id: o.id, kind: 'password' })}
                              disabled={working}
                              className="rounded-r1 border border-border px-1.5 py-0.5 text-faint transition-colors duration-micro hover:text-dim disabled:opacity-40"
                            >
                              reset pw
                            </button>
                            <button
                              onClick={() => setEditing({ id: o.id, kind: 'remove' })}
                              disabled={isSelf || lastAdmin || working}
                              title={isSelf ? 'You cannot remove your own account' : lastAdmin ? 'The last admin cannot be removed' : undefined}
                              className="rounded-r1 border border-border px-1.5 py-0.5 text-danger transition-colors duration-micro hover:bg-danger/14 disabled:opacity-30"
                            >
                              remove
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>

        {/* footer */}
        <div className="border-t border-border px-4 py-2 text-caption text-faint">
          {tab === 'connections'
            ? 'Set values in backend/.env and restart. OAuth flows are an external prerequisite.'
            : 'The last admin can’t be demoted or removed; you can’t remove your own account here.'}
        </div>
      </div>
    </div>
  );
}

/* ── inline rename / password / remove ───────────────────────────────────
   Replaces window.prompt() and window.confirm(). Each opens in the operator's
   own card, so the action stays anchored to the row it affects. */
function InlineFlow({
  kind,
  operator,
  onCancel,
  onRename,
  onPassword,
  onRemove,
}: {
  kind: 'rename' | 'password' | 'remove';
  operator: SafeUser;
  onCancel: () => void;
  onRename: (name: string) => void;
  onPassword: (pw: string) => void;
  onRemove: () => void;
}) {
  const [value, setValue] = useState(kind === 'rename' ? operator.name : '');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  if (kind === 'remove') {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-r2 border border-danger/40 bg-danger/[0.08] px-2.5 py-2">
        <span className="min-w-0 flex-1 text-caption leading-snug text-dim">
          Remove <span className="font-semibold text-text">{operator.email}</span>? This cannot be undone.
        </span>
        <button
          onClick={onCancel}
          className="shrink-0 rounded-r1 border border-border px-2 py-0.5 text-caption text-faint transition-colors duration-micro hover:text-dim"
        >
          Cancel
        </button>
        <button
          onClick={onRemove}
          className="shrink-0 rounded-r1 bg-danger px-2 py-0.5 text-caption font-medium text-bg-raised transition-opacity duration-micro hover:opacity-90"
        >
          Remove
        </button>
      </div>
    );
  }

  const isPw = kind === 'password';
  const ok = isPw ? value.length >= 12 : value.trim().length > 0;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        if (isPw) onPassword(value);
        else onRename(value);
      }}
      className="mt-2 flex items-center gap-2"
    >
      <input
        ref={input}
        type={isPw ? 'password' : 'text'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        placeholder={isPw ? 'new password (min 12 characters)' : 'name'}
        className="min-w-0 flex-1 rounded-r2 border border-border bg-bg-raised px-2 py-1 text-caption outline-none transition-colors duration-micro focus:border-border-strong"
      />
      <button
        type="button"
        onClick={onCancel}
        className="shrink-0 rounded-r1 border border-border px-2 py-1 text-caption text-faint transition-colors duration-micro hover:text-dim"
      >
        Cancel
      </button>
      <button
        disabled={!ok}
        className="shrink-0 rounded-r1 border border-accent-dim bg-accent-dim/14 px-2 py-1 text-caption font-medium text-accent transition-colors duration-micro hover:bg-accent-dim/24 disabled:opacity-40"
      >
        {isPw ? 'Reset' : 'Save'}
      </button>
    </form>
  );
}

function CreateForm({ onCreate }: { onCreate: (o: { email: string; password: string; name: string; role: string }) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('technical');
  const [busy, setBusy] = useState(false);

  const ok = email.trim() && name.trim() && password.length >= 12;

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ok || busy) return;
        setBusy(true);
        try {
          await onCreate({ email: email.trim(), name: name.trim(), password, role });
          setEmail('');
          setName('');
          setPassword('');
        } finally {
          setBusy(false);
        }
      }}
      className="mb-3 grid grid-cols-2 gap-2 rounded-r3 border border-border bg-bg-inset/60 p-2.5"
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="name"
        className="rounded-r2 border border-border bg-bg-raised px-2 py-1.5 text-body outline-none focus:border-border-strong"
      />
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        type="email"
        placeholder="email"
        className="rounded-r2 border border-border bg-bg-raised px-2 py-1.5 text-body outline-none focus:border-border-strong"
      />
      <input
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        type="password"
        placeholder="password (min 12)"
        className="rounded-r2 border border-border bg-bg-raised px-2 py-1.5 text-body outline-none focus:border-border-strong"
      />
      <select
        value={role}
        onChange={(e) => setRole(e.target.value)}
        className="rounded-r2 border border-border bg-bg-raised px-2 py-1.5 text-body text-dim outline-none"
      >
        {ROLES.filter((r) => r !== 'admin').map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <button
        disabled={!ok || busy}
        className="col-span-2 rounded-r2 border border-accent-dim bg-accent-dim/14 px-3 py-1.5 text-body font-medium text-accent transition-colors hover:bg-accent-dim/24 disabled:opacity-40"
      >
        {busy ? 'creating…' : 'create operator'}
      </button>
    </form>
  );
}


/* ── Google Search Console + Analytics ──────────────────────────────────
   The one connector in this panel with a real action: a 3-legged OAuth
   connect per operator, then a per-project site / property mapping and a
   live data preview so it is obvious the link works. */

const GOOGLE_META: Record<
  GoogleService,
  { name: string; noun: string; blurb: string }
> = {
  'search-console': {
    name: 'Search Console',
    noun: 'site',
    blurb: 'Clicks, impressions, CTR, average position & top queries',
  },
  analytics: {
    name: 'Analytics (GA4)',
    noun: 'property',
    blurb: 'Sessions, users, page views, engagement & channel mix',
  },
};

const compact = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n));

function GoogleConnections({
  activeProject,
  onNotify,
  onRecheck,
}: {
  activeProject: { id: string; domain: string } | null;
  onNotify: (msg: string, tone?: 'ok' | 'warn') => void;
  onRecheck: () => Promise<void>;
}) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [conns, setConns] = useState<GoogleConnectionView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [st, list] = await Promise.all([
        getGoogleStatus().catch(() => ({ configured: false })),
        listGoogleConnections(),
      ]);
      setConfigured(st.configured);
      setConns(list);
    } catch (e) {
      setConns([]);
      setConfigured(null);
      setErr(e instanceof ApiError ? e.message : 'could not load Google connections');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const nConnected = (conns ?? []).filter((c) => c.connected && !c.expired).length;

  return (
    <div className="mb-4 overflow-hidden rounded-r3 border border-border bg-bg-raised">
      <div className="flex items-center gap-2.5 border-b border-border bg-bg-inset/50 px-3 py-2.5">
        <GoogleGlyph className="h-4 w-4" />
        <span className="text-body font-semibold text-text">Google · Search Console &amp; Analytics</span>
        <span
          className={`ml-auto shrink-0 rounded-full border px-1.5 py-0.5 text-eyebrow font-semibold uppercase tracking-wide2 ${
            nConnected > 0 ? 'border-accent-dim text-accent' : 'border-border text-faint'
          }`}
        >
          {conns === null ? '…' : nConnected > 0 ? `${nConnected} connected` : 'not connected'}
        </span>
      </div>

      {err && <p className="px-3 pt-2 text-caption text-danger">{err}</p>}

      {configured === false && (
        <p className="px-3 pt-2.5 text-caption leading-snug text-warn">
          The OAuth client is not set on the server. An admin needs{' '}
          <code className="rounded-r1 bg-bg-inset px-1 text-dim">GOOGLE_OAUTH_CLIENT_ID</code> +{' '}
          <code className="rounded-r1 bg-bg-inset px-1 text-dim">GOOGLE_OAUTH_CLIENT_SECRET</code> in the backend env.
        </p>
      )}

      <div className="divide-y divide-border/70">
        {(['search-console', 'analytics'] as GoogleService[]).map((service) => (
          <GoogleServiceCard
            key={service}
            service={service}
            conn={conns?.find((c) => c.service === service) ?? null}
            configured={configured !== false}
            activeProject={activeProject}
            onNotify={onNotify}
            onChanged={async () => {
              await Promise.all([load(), onRecheck()]);
            }}
          />
        ))}
      </div>

      <p className="border-t border-border/70 px-3 py-2 text-caption text-faint">
        Connects your own Google account, read-only. Tokens are encrypted at rest; disconnect revokes them at Google.
      </p>
    </div>
  );
}

function GoogleServiceCard({
  service,
  conn,
  configured,
  activeProject,
  onNotify,
  onChanged,
}: {
  service: GoogleService;
  conn: GoogleConnectionView | null;
  configured: boolean;
  activeProject: { id: string; domain: string } | null;
  onNotify: (msg: string, tone?: 'ok' | 'warn') => void;
  onChanged: () => Promise<void>;
}) {
  const meta = GOOGLE_META[service];
  const [busy, setBusy] = useState<null | 'connect' | 'disconnect'>(null);
  const connected = Boolean(conn?.connected);
  const expired = Boolean(conn?.expired);

  const connect = async () => {
    setBusy('connect');
    try {
      const { url } = await authorizeGoogle(service, activeProject?.id);
      const popup = window.open(url, 'cailyx-google-oauth', 'width=520,height=700');
      if (!popup) {
        onNotify('Allow pop-ups for this site, then try connecting again', 'warn');
        return;
      }
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (popup.closed) {
            clearInterval(t);
            resolve();
          }
        }, 700);
      });
      await onChanged();
    } catch (e) {
      onNotify(e instanceof ApiError ? e.message : 'could not start the Google connect', 'warn');
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy('disconnect');
    try {
      await disconnectGoogle(service);
      onNotify(`${meta.name} disconnected`);
      await onChanged();
    } catch (e) {
      onNotify(e instanceof ApiError ? e.message : 'could not disconnect', 'warn');
    } finally {
      setBusy(null);
    }
  };

  const statusPill = expired
    ? { label: 'reauthorise', cls: 'border-warn/50 text-warn' }
    : connected
      ? { label: 'connected', cls: 'border-accent-dim text-accent' }
      : { label: 'not connected', cls: 'border-border text-faint' };

  return (
    <div className="p-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-r2 bg-bg-inset">
          <GoogleGlyph className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-body font-semibold text-dim">{meta.name}</span>
            <span
              className={`ml-auto shrink-0 rounded-full border px-1.5 py-0.5 text-eyebrow font-semibold uppercase tracking-wide2 ${statusPill.cls}`}
            >
              {statusPill.label}
            </span>
          </div>
          <p className="mt-0.5 text-caption leading-snug text-faint">
            {connected ? (
              <>
                {conn?.googleEmail ?? 'Google account'}
                {conn?.lastError ? <span className="text-danger"> · {conn.lastError}</span> : null}
              </>
            ) : (
              meta.blurb
            )}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {!connected && (
              <button
                onClick={() => void connect()}
                disabled={!configured || busy !== null}
                className="inline-flex items-center gap-1.5 rounded-r2 border border-accent-dim bg-accent-dim/14 px-2.5 py-1 text-caption font-semibold text-accent transition-colors duration-micro hover:bg-accent-dim/24 disabled:opacity-40"
              >
                {busy === 'connect' ? 'opening Google…' : `Connect ${meta.name} ↗`}
              </button>
            )}
            {connected && (
              <>
                <button
                  onClick={() => void connect()}
                  disabled={busy !== null}
                  className="rounded-r1 border border-border px-2 py-0.5 text-caption text-faint transition-colors duration-micro hover:text-dim disabled:opacity-40"
                >
                  {busy === 'connect' ? 'opening…' : expired ? 'reconnect ↗' : 're-authorise'}
                </button>
                <button
                  onClick={() => void disconnect()}
                  disabled={busy !== null}
                  className="rounded-r1 border border-border px-2 py-0.5 text-caption text-faint transition-colors duration-micro hover:text-danger disabled:opacity-40"
                >
                  {busy === 'disconnect' ? 'working…' : 'disconnect'}
                </button>
              </>
            )}
          </div>

          {connected && !expired && (
            <GoogleResourcePicker service={service} activeProject={activeProject} onNotify={onNotify} />
          )}
        </div>
      </div>
    </div>
  );
}

function GoogleResourcePicker({
  service,
  activeProject,
  onNotify,
}: {
  service: GoogleService;
  activeProject: { id: string; domain: string } | null;
  onNotify: (msg: string, tone?: 'ok' | 'warn') => void;
}) {
  const [data, setData] = useState<GoogleResourcesView | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const noun = GOOGLE_META[service].noun;

  useEffect(() => {
    if (!activeProject) return;
    let alive = true;
    setData(null);
    setFailed(false);
    getGoogleResources(service, activeProject.id)
      .then((r) => alive && setData(r))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [service, activeProject]);

  if (!activeProject) {
    return (
      <p className="mt-2 rounded-r2 bg-bg-inset/60 px-2.5 py-1.5 text-caption text-faint">
        Select a project (top bar) to map a {noun} to it.
      </p>
    );
  }
  if (failed) {
    return <p className="mt-2 text-caption text-faint">Could not list {noun}s — re-authorise?</p>;
  }
  if (!data) return <p className="mt-2 text-caption text-faint">loading {noun} list…</p>;
  if (!data.connected) {
    return (
      <p className="mt-2 text-caption text-warn">
        Couldn&rsquo;t list {noun}s.{' '}
        {service === 'analytics'
          ? 'Check the Analytics Admin API is enabled on the OAuth project, then re-authorise.'
          : 'Re-authorise the connection.'}
      </p>
    );
  }
  if (data.options.length === 0) {
    return (
      <p className="mt-2 text-caption text-faint">
        This Google account has no {noun} it can read. Grant it access in {GOOGLE_META[service].name} first.
      </p>
    );
  }

  const choose = async (resourceId: string) => {
    if (!resourceId) return;
    const opt = data.options.find((o) => o.id === resourceId);
    setSaving(true);
    try {
      await setGoogleResource({ service, projectId: activeProject.id, resourceId, resourceLabel: opt?.label });
      setData({ ...data, selected: { resourceId, resourceLabel: opt?.label ?? null } });
      onNotify(`${GOOGLE_META[service].name} ${noun} mapped to ${activeProject.domain}`);
    } catch (e) {
      onNotify(e instanceof ApiError ? e.message : 'could not save the mapping', 'warn');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 rounded-r2 border border-border/70 bg-bg-inset/40 p-2">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-caption text-faint">{activeProject.domain} →</span>
        <select
          value={data.selected?.resourceId ?? ''}
          disabled={saving}
          onChange={(e) => void choose(e.target.value)}
          className="min-w-0 flex-1 rounded-r2 border border-border bg-bg-raised px-1.5 py-1 text-caption text-dim outline-none focus:border-border-strong disabled:opacity-50"
        >
          <option value="" disabled>
            choose a {noun}…
          </option>
          {data.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
              {o.detail ? ` — ${o.detail}` : ''}
            </option>
          ))}
        </select>
      </div>
      {data.selected && (
        <GoogleDataPreview service={service} projectId={activeProject.id} key={data.selected.resourceId} />
      )}
    </div>
  );
}

function GoogleDataPreview({
  service,
  projectId,
}: {
  service: GoogleService;
  projectId: string;
}) {
  const [text, setText] = useState<string>('loading last 28 days…');

  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        if (service === 'search-console') {
          const s = await getSearchConsoleSummary(projectId, 28);
          if (alive)
            setText(
              `${compact(s.totals.clicks)} clicks · ${compact(s.totals.impressions)} impressions · ` +
                `${(s.totals.ctr * 100).toFixed(1)}% CTR · pos ${s.totals.position.toFixed(1)}`,
            );
        } else {
          const s = await getAnalyticsSummary(projectId, 28);
          if (alive)
            setText(
              `${compact(s.totals.sessions)} sessions · ${compact(s.totals.totalUsers)} users · ` +
                `${compact(s.totals.screenPageViews)} views · ${(s.totals.engagementRate * 100).toFixed(0)}% engaged`,
            );
        }
      } catch (e) {
        if (alive) setText(e instanceof ApiError ? e.message : 'no data yet');
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [service, projectId]);

  return <p className="mt-1.5 text-caption tabular-nums text-dim">{text}</p>;
}
