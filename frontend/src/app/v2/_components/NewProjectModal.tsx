'use client';

/**
 * NewProjectModal — /v2. Creates a project (`POST /projects`). Shown on demand
 * from the project switcher, and forced open (undismissable) when the account
 * has no projects at all, since the whole console needs one.
 *
 * @module app/v2/_components/NewProjectModal
 */

import { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from '../_lib/useFocusTrap';

/** strip a pasted URL down to a bare host — the backend wants a domain */
function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

export function NewProjectModal({
  dismissable,
  onClose,
  onCreate,
}: {
  dismissable: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; domain: string; category?: string }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const card = useRef<HTMLFormElement>(null);

  useFocusTrap(true, card);

  useEffect(() => {
    if (!dismissable) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismissable, onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onCreate({
        name: name.trim(),
        domain: normalizeDomain(domain),
        category: category.trim() || undefined,
      });
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'create failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[65] flex items-start justify-center p-4 pt-[14vh]">
      <div
        className="absolute inset-0 bg-[#1a1712]/40 backdrop-blur-sm"
        onClick={dismissable ? onClose : undefined}
        aria-hidden
      />

      <form
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label="New project"
        onSubmit={submit}
        className="v2-pop relative w-full max-w-sm overflow-hidden rounded-r4 border border-border bg-bg-raised shadow-e3"
      >
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-ui font-semibold tracking-tight2 text-text">New project</h2>
          <p className="text-caption text-faint">
            {dismissable ? 'a domain to diagnose' : 'the console needs one project to work against'}
          </p>
        </div>

        <div className="space-y-3 p-4">
          <Field label="name" value={name} onChange={setName} placeholder="Acme" required minLength={2} autoFocus />
          <Field label="domain" value={domain} onChange={setDomain} placeholder="acme.com" required />
          <Field
            label="category (optional)"
            value={category}
            onChange={setCategory}
            placeholder="AI visibility diagnostics"
          />
          {err && <p className="text-body text-danger">{err}</p>}

          <div className="flex gap-2 pt-1">
            <button
              disabled={busy || !name.trim() || !domain.trim()}
              className="flex-1 rounded-r2 border border-accent-dim bg-accent-dim/20 px-3 py-2 text-body font-medium text-accent transition-colors hover:bg-accent-dim/30 disabled:opacity-50"
            >
              {busy ? 'creating…' : 'create'}
            </button>
            {dismissable && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-r2 border border-border px-3 py-2 text-body text-faint transition-colors hover:text-dim"
              >
                cancel
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  required,
  minLength,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
  autoFocus?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-caption font-medium uppercase tracking-eyebrow text-faint">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        minLength={minLength}
        autoFocus={autoFocus}
        className="w-full rounded-r2 border border-border bg-bg-inset px-3 py-2 text-ui outline-none transition-colors focus:border-border-strong"
      />
    </label>
  );
}
