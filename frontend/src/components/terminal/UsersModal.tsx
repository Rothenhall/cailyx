'use client';

/**
 * User Management — list / create / re-role / reset-password / delete operators.
 * Admin only (the backend `/users` routes are `@Roles('admin')`).
 *
 * @module components/terminal/UsersModal
 */

import { useCallback, useEffect, useState } from 'react';
import {
  createUser,
  deleteUser,
  getUserRoles,
  listUsers,
  resetUserPassword,
  updateUser,
} from '@/lib/terminal-api';
import type { SafeUser } from '@/types/terminal';

export function UsersModal({ currentUserId, onClose }: { currentUserId: string | null; onClose: () => void }) {
  const [users, setUsers] = useState<SafeUser[] | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [u, r] = await Promise.all([listUsers(), getUserRoles()]);
      setUsers(u);
      setRoles(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed to load users');
      setUsers([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2500);
  };

  const changeRole = async (u: SafeUser, role: string) => {
    setErr(null);
    try {
      const updated = await updateUser(u.id, { role });
      setUsers((prev) => prev?.map((x) => (x.id === u.id ? updated : x)) ?? null);
      flash(`${u.email} → ${role}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'update failed');
    }
  };

  const rename = async (u: SafeUser) => {
    const name = window.prompt('New name for ' + u.email, u.name);
    if (!name || name.trim() === u.name) return;
    try {
      const updated = await updateUser(u.id, { name: name.trim() });
      setUsers((prev) => prev?.map((x) => (x.id === u.id ? updated : x)) ?? null);
      flash('renamed');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'rename failed');
    }
  };

  const resetPw = async (u: SafeUser) => {
    const pw = window.prompt(`New password for ${u.email} (min 10 chars). Their sessions will be revoked.`);
    if (!pw) return;
    try {
      const res = await resetUserPassword(u.id, pw);
      flash(`password reset · ${res.sessionsRevoked} session(s) revoked`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'reset failed');
    }
  };

  const remove = async (u: SafeUser) => {
    if (!window.confirm(`Delete operator ${u.email}? This cannot be undone.`)) return;
    try {
      await deleteUser(u.id);
      setUsers((prev) => prev?.filter((x) => x.id !== u.id) ?? null);
      flash('deleted');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'delete failed');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[#1a1712]/45 p-6" onClick={onClose}>
      <div className="mt-8 w-full max-w-2xl rounded-lg border border-border bg-bg-raised shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-[12px] font-semibold uppercase tracking-widest text-dim">User management</h2>
            <p className="text-[11px] text-faint">{users ? `${users.length} operator(s)` : 'loading…'}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowCreate((s) => !s)}
              className="rounded border border-accent-dim bg-accent-dim/20 px-2 py-1 text-[11px] text-accent"
            >
              {showCreate ? 'close form' : '+ new operator'}
            </button>
            <button onClick={onClose} className="rounded p-1 text-faint hover:text-dim">✕</button>
          </div>
        </header>

        {showCreate && (
          <CreateForm
            roles={roles}
            onCreated={(u) => {
              setUsers((prev) => [u, ...(prev ?? [])]);
              setShowCreate(false);
              flash('operator created');
            }}
            onError={setErr}
          />
        )}

        <div className="max-h-[62vh] overflow-y-auto p-3">
          {(err || msg) && (
            <p className={`mb-2 text-[11px] ${err ? 'text-red' : 'text-accent'}`}>{err ?? msg}</p>
          )}
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-border text-left text-[10px] uppercase tracking-widest text-faint">
                <th className="py-1.5">Operator</th>
                <th className="py-1.5">Role</th>
                <th className="py-1.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(users ?? []).map((u) => (
                <tr key={u.id} className="border-b border-border/50">
                  <td className="py-2 pr-2">
                    <div className="text-dim">
                      {u.name}
                      {u.id === currentUserId && <span className="ml-2 text-[10px] text-accent">you</span>}
                    </div>
                    <div className="text-[11px] text-faint">{u.email}</div>
                  </td>
                  <td className="py-2 pr-2">
                    <select
                      value={u.role}
                      onChange={(e) => changeRole(u, e.target.value)}
                      className="rounded border border-border bg-bg-inset px-1.5 py-1 text-[11px] text-dim outline-none"
                    >
                      {roles.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 text-right">
                    <div className="inline-flex gap-1 text-[10px]">
                      <button onClick={() => rename(u)} className="rounded border border-border px-1.5 py-0.5 text-faint hover:text-dim">
                        rename
                      </button>
                      <button onClick={() => resetPw(u)} className="rounded border border-border px-1.5 py-0.5 text-faint hover:text-dim">
                        reset pw
                      </button>
                      <button
                        onClick={() => remove(u)}
                        disabled={u.id === currentUserId}
                        className="rounded border border-border px-1.5 py-0.5 text-red hover:bg-red/10 disabled:opacity-30"
                      >
                        delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {users?.length === 0 && <p className="py-4 text-center text-faint">no operators</p>}
        </div>

        <footer className="border-t border-border px-4 py-2 text-[11px] text-faint">
          Roles: admin sees everything. The last admin cannot be demoted or deleted; you cannot delete your own account here.
        </footer>
      </div>
    </div>
  );
}

function CreateForm({
  roles,
  onCreated,
  onError,
}: {
  roles: string[];
  onCreated: (u: SafeUser) => void;
  onError: (m: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(roles.find((r) => r !== 'admin') ?? 'technical');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!roles.includes(role)) setRole(roles.find((r) => r !== 'admin') ?? roles[0] ?? 'technical');
  }, [roles, role]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const u = await createUser({ email: email.trim(), name: name.trim(), password, role });
      onCreated(u);
      setEmail('');
      setName('');
      setPassword('');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'create failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid grid-cols-2 gap-2 border-b border-border bg-bg-inset p-3">
      <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required placeholder="email"
        className="rounded border border-border bg-bg-raised px-2 py-1.5 text-[12px] outline-none focus:border-border-strong" />
      <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} placeholder="name"
        className="rounded border border-border bg-bg-raised px-2 py-1.5 text-[12px] outline-none focus:border-border-strong" />
      <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required minLength={10} placeholder="password (min 10)"
        className="rounded border border-border bg-bg-raised px-2 py-1.5 text-[12px] outline-none focus:border-border-strong" />
      <div className="flex gap-2">
        <select value={role} onChange={(e) => setRole(e.target.value)}
          className="flex-1 rounded border border-border bg-bg-raised px-2 py-1.5 text-[12px] text-dim outline-none">
          {roles.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <button disabled={busy} className="rounded border border-accent-dim bg-accent-dim/20 px-3 py-1.5 text-[12px] text-accent disabled:opacity-50">
          {busy ? '…' : 'create'}
        </button>
      </div>
    </form>
  );
}
