'use client';

/**
 * Dashboard: the project list (Wave 0 projects module) + create form.
 * Redirects to /login when no token is stored.
 *
 * @module app/page
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, getToken, ApiError } from '@/lib/api';
import { Project } from '@/types/api';

export default function DashboardPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && getToken() === null) router.push('/login');
  }, [router]);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ projects: Project[] }>('/projects');
      setProjects(res.projects);
      setError(null);
    } catch (err) {
      setProjects([]);
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    }
  }, []);

  useEffect(() => {
    if (getToken() !== null) void load();
  }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch<Project>('/projects', { method: 'POST', json: { name, domain } });
      setName('');
      setDomain('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
      if (err instanceof ApiError && err.status === 401) router.push('/login');
    } finally {
      setBusy(false);
    }
  };

  if (projects === null) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">Projects</h1>
      <p className="mb-6 text-sm text-slate-600">Every engagement starts here — pick a project to open its diagnostic workspace.</p>

      <form onSubmit={create} className="mb-8 flex flex-wrap gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <input className={inputClass + ' flex-1 min-w-[180px]'} placeholder="Project name" value={name}
          onChange={(e) => setName(e.target.value)} required minLength={2} />
        <input className={inputClass + ' flex-1 min-w-[180px]'} placeholder="domain.com" value={domain}
          onChange={(e) => setDomain(e.target.value)} required />
        <button disabled={busy}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50">
          {busy ? 'Creating…' : 'Add project'}
        </button>
      </form>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {projects.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          No projects yet — add your first client above.
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/projects/${p.id}`}
                className="block rounded-lg border border-slate-200 bg-white p-4 transition hover:border-slate-400"
              >
                <p className="font-medium">{p.name}</p>
                <p className="mt-1 text-xs text-slate-500">{p.domain}</p>
                {p.status && (
                  <span className="mt-3 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    {p.status}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const inputClass =
  'rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none';