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
import { BoltIcon, CloseIcon } from './icons';
import { createUser, deleteUser, listUsers, resetUserPassword, updateUser } from '@/lib/terminal-api';
import type { User } from '@/types/api';
import type { Integration, IntegrationCategory, SafeUser } from '@/types/terminal';

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
          <code className="rounded bg-bg-raised px-1.5 py-0.5 text-caption text-dim">{i.configHint}</code>
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
    <li className="rounded-r2 border border-border/60 bg-bg-inset/50 px-2.5 py-2">
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
  onRecheck,
  onNotify,
}: {
  open: 'connections' | 'users' | null;
  onClose: () => void;
  user: User | null;
  integrations: Integration[];
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

  const configurable = integrations.filter((i) => i.category !== 'mode');
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
            <p className="text-caption text-faint">connections, setup gates &amp; team</p>
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
              <div className="mb-4 rounded-r3 border border-border bg-bg-inset/50 p-3">
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
              <div className="mt-5 rounded-r3 border border-warn/40 bg-warn/[0.06] p-3">
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
                  className="rounded-r2 border border-accent-dim bg-accent-dim/15 px-2.5 py-1 text-body font-medium text-accent transition-colors hover:bg-accent-dim/25"
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
                          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-dim/25 text-caption font-semibold text-accent">
                            {o.name.slice(0, 1).toUpperCase()}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 text-body font-semibold text-dim">
                              <span className="truncate">{o.name}</span>
                              {isSelf && <span className="rounded bg-accent-dim/25 px-1 text-eyebrow uppercase text-accent">you</span>}
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
                              className="rounded-r1 border border-border px-1.5 py-0.5 text-danger transition-colors duration-micro hover:bg-danger/10 disabled:opacity-30"
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
      <div className="mt-2 flex items-center gap-2 rounded-r2 border border-danger/40 bg-danger/[0.06] px-2.5 py-2">
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
        isPw ? onPassword(value) : onRename(value);
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
        className="shrink-0 rounded-r1 border border-accent-dim bg-accent-dim/15 px-2 py-1 text-caption font-medium text-accent transition-colors duration-micro hover:bg-accent-dim/25 disabled:opacity-40"
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
        className="col-span-2 rounded-r2 border border-accent-dim bg-accent-dim/15 px-3 py-1.5 text-body font-medium text-accent transition-colors hover:bg-accent-dim/25 disabled:opacity-40"
      >
        {busy ? 'creating…' : 'create operator'}
      </button>
    </form>
  );
}
