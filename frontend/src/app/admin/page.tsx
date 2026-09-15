'use client';

/**
 * Client list — the admin console's home screen. Every existing client with
 * its progress overview, plus "Add Client" which creates the client and
 * kicks off the Day-1 pipeline for its first project.
 *
 * @module app/admin/page
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { createClient, createClientProject, listClients } from '@/lib/admin-api';
import type { ClientListItem } from '@/types/admin';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  active: 'default',
  paused: 'secondary',
  churned: 'destructive',
};

export default function ClientListPage() {
  const router = useRouter();
  const [clients, setClients] = useState<ClientListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);

  const refresh = () => {
    listClients()
      .then(setClients)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load clients'));
  };

  useEffect(refresh, []);

  const filtered = useMemo(() => {
    if (!clients) return null;
    const q = query.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.contactEmail ?? '').toLowerCase().includes(q),
    );
  }, [clients, query]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
          <p className="text-sm text-muted-foreground">
            {clients ? `${clients.length} client${clients.length === 1 ? '' : 's'}` : 'Loading…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Search clients…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-56"
          />
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button>Add Client</Button>
            </SheetTrigger>
            <SheetContent>
              <AddClientForm
                onDone={(clientId) => {
                  setSheetOpen(false);
                  refresh();
                  router.push(`/admin/clients/${clientId}`);
                }}
              />
            </SheetContent>
          </Sheet>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {!clients && !error && (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {filtered && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Projects</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Open gaps</TableHead>
                <TableHead>Onboarding</TableHead>
                <TableHead className="text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                    No clients yet — add the first one.
                  </TableCell>
                </TableRow>
              )}
              {filtered.map((c) => (
                <TableRow
                  key={c.id}
                  className="cursor-pointer"
                  onClick={() => router.push(`/admin/clients/${c.id}`)}
                >
                  <TableCell>
                    <div className="font-medium">{c.name}</div>
                    {c.contactEmail && <div className="text-xs text-muted-foreground">{c.contactEmail}</div>}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[c.status] ?? 'outline'} className="capitalize">
                      {c.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{c.projectCount}</TableCell>
                  <TableCell>
                    {c.latestScore != null ? (
                      <span>
                        {c.latestScore}
                        {c.latestBand && <span className="ml-1 text-xs text-muted-foreground">({c.latestBand})</span>}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>{c.openGapCount}</TableCell>
                  <TableCell>
                    {c.hasProjectOnboarding ? (
                      <Badge variant="secondary">running</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {new Date(c.updatedAt).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/** Strip protocol/path/trailing slash so we always send a bare domain (matches
 * the backend's own `IntakeService.normalizeDomain`) — "https://acme.com/" -> "acme.com". */
function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}

function AddClientForm({ onDone }: { onDone: (clientId: string) => void }) {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [runAeoAudit, setRunAeoAudit] = useState(false);
  const [runKeywordResearch, setRunKeywordResearch] = useState(false);
  const [runGrowthExecution, setRunGrowthExecution] = useState(false);
  const [runBacklinksRefresh, setRunBacklinksRefresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanDomain = normalizeDomain(domain);
    setDomain(cleanDomain);
    setBusy(true);
    setErr(null);
    try {
      const client = await createClient({
        name,
        contactName: contactName || undefined,
        contactEmail: contactEmail || undefined,
      });
      try {
        await createClientProject(client.id, {
          name,
          domain: cleanDomain,
          runAeoAudit,
          runKeywordResearch,
          runGrowthExecution,
          runBacklinksRefresh,
        });
        toast.success('Client added — Day-1 pipeline running', {
          description: `${cleanDomain} will have a first report shortly.`,
        });
      } catch (projErr) {
        // client exists even if the project step failed (e.g. duplicate domain) — still hand off
        toast.warning('Client created, but the project step failed', {
          description: projErr instanceof Error ? projErr.message : undefined,
        });
      }
      onDone(client.id);
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Could not create client');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex h-full flex-col">
      <SheetHeader>
        <SheetTitle>Add a new client</SheetTitle>
        <SheetDescription>
          Creates the client and kicks off the Day-1 pipeline (technical audit → presence → tech
          stack → competitors → gap analysis → strategy → report) in the background.
        </SheetDescription>
      </SheetHeader>
      <div className="flex flex-1 flex-col gap-4 px-4">
        <Field label="Client / company name" value={name} onChange={setName} required minLength={1} placeholder="Acme Corp" />
        <Field
          label="Website domain"
          value={domain}
          onChange={setDomain}
          onBlur={() => setDomain((d) => normalizeDomain(d))}
          required
          minLength={3}
          placeholder="acme.com"
        />
        <Field label="Contact name" value={contactName} onChange={setContactName} placeholder="Jane Doe" />
        <Field label="Contact email" value={contactEmail} onChange={setContactEmail} type="email" placeholder="jane@acme.com" />

        <div className="grid gap-2 rounded-lg border p-3">
          <p className="text-xs font-medium text-muted-foreground">
            Optional Day-1 stages <span className="font-normal">(real spend per run — off by default)</span>
          </p>
          <OptInRow
            label="AEO audit"
            description="Answer-engine visibility across ChatGPT/Perplexity/etc. — Cloro + LLM credits, can take several minutes."
            checked={runAeoAudit}
            onChange={setRunAeoAudit}
          />
          <OptInRow
            label="Keyword research"
            description="Search volume/CPC seeded from the auto-detected category — DataForSEO credits."
            checked={runKeywordResearch}
            onChange={setRunKeywordResearch}
          />
          <OptInRow
            label="Growth execution"
            description="Draft asset briefs (articles, ad copy, etc.) from the strategy output."
            checked={runGrowthExecution}
            onChange={setRunGrowthExecution}
          />
          <OptInRow
            label="Backlinks refresh"
            description="Pull a fresh backlinks profile from DataForSEO for the Reports tab."
            checked={runBacklinksRefresh}
            onChange={setRunBacklinksRefresh}
          />
        </div>

        {err && <p className="text-sm text-destructive">{err}</p>}
      </div>
      <SheetFooter>
        <Button type="submit" disabled={busy || !name || !domain}>
          {busy ? 'Creating…' : 'Add client & run pipeline'}
        </Button>
      </SheetFooter>
    </form>
  );
}

function OptInRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = `optin-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <label htmlFor={id} className="flex items-start gap-2.5">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
      <span>
        <span className="text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

function Field({
  label,
  value,
  onChange,
  onBlur,
  type = 'text',
  required,
  minLength,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  type?: string;
  required?: boolean;
  minLength?: number;
  placeholder?: string;
}) {
  const id = `f-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        required={required}
        minLength={minLength}
        placeholder={placeholder}
      />
    </div>
  );
}
