'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Search,
  Upload,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { intakeBulk, intakeSubject, type IntakeBulkResult, type IntakeSubjectResult } from '@/services/sales';

/**
 * SL01 — Intake.
 *
 * design_plan.md §4.2: *"Single domain enrichment, editable inputs; bulk file
 * preview/validation/results."* §5.11 adds the two facts that decide this
 * screen's shape:
 *
 *  - *"Bulk intake accepts parsed JSON items, not multipart files; preview
 *    duplicates/invalid rows and show per-row results."* So the browser does
 *    the CSV parsing and the operator sees exactly what will be sent, row by
 *    row, before anything is sent.
 *  - *"Sales starts with operator-authenticated intake."* This is not the
 *    public form; nothing here runs on load, and enrichment never happens
 *    because a page was opened.
 *
 * ## What this screen will not claim
 *
 * The bulk response reports `created` as a **count** and lists `skipped` rows,
 * but each `enriched` row carries no `projectId` and no `created` flag — unlike
 * the single-subject route. A per-row "this attached to an existing project"
 * verdict therefore cannot be derived from the response, and is not shown. The
 * screen reports the counts the API actually returns and says where the
 * per-row detail stops.
 *
 * Both routes are rate-limited (5/min and 2/min) because every row triggers a
 * real fetch and extraction. The limits are stated before the button, not
 * discovered as a 429.
 */

interface ParsedRow {
  line: number;
  domain: string;
  company: string;
  /** Why this row will not be sent, if it will not. */
  problem: string | null;
}

/** Minimal RFC-4180-ish CSV/TSV split — quoted fields with embedded delimiters. */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * A domain is checked against the same shape the server normalises: scheme
 * stripped, path dropped, lowercased. Anything that would normalise to nothing
 * is refused here rather than sent and rejected row by row.
 */
function normaliseDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .trim();
}

function domainProblem(domain: string): string | null {
  if (!domain) return 'No domain in this row.';
  // A dot and a plausible TLD. Deliberately permissive: the server is the
  // authority on what it will fetch, and a stricter client rule would refuse
  // domains it would have accepted.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
    return 'This does not look like a bare domain (for example "example.com").';
  }
  return null;
}

export default function SalesIntakePage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Intake"
        context="Enrich a single domain, or preview and submit a list."
      />

      <Alert>
        <AlertTriangle aria-hidden="true" className="h-4 w-4" />
        <AlertTitle>Enrichment creates real work and spends real budget</AlertTitle>
        <AlertDescription>
          Each item fetches the site, reads its structured data and extracts
          positioning copy and named competitors, then creates or attaches a
          project. Nothing on this page runs on load. The single-domain route is
          limited to 5 requests a minute and bulk to 2, because every row is a
          full enrichment.
        </AlertDescription>
      </Alert>

      <Tabs defaultValue="single">
        <TabsList>
          <TabsTrigger value="single">Single domain</TabsTrigger>
          <TabsTrigger value="bulk">Bulk list</TabsTrigger>
        </TabsList>
        <TabsContent value="single" className="pt-4">
          <SingleIntake />
        </TabsContent>
        <TabsContent value="bulk" className="pt-4">
          <BulkIntake />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Single domain ───────────────────────────────────────────────────────

function SingleIntake() {
  const [domain, setDomain] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [description, setDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [result, setResult] = useState<IntakeSubjectResult | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    // Double-submit guard: an enrichment is not idempotent from the operator's
    // point of view, and a second identical request is a second fetch.
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const enriched = await intakeSubject({
        domain,
        company: company.trim() === '' ? undefined : company,
        email: email.trim() === '' ? undefined : email,
        phone: phone.trim() === '' ? undefined : phone,
        description: description.trim() === '' ? undefined : description,
        notes: notes.trim() === '' ? undefined : notes,
        source: 'operator-console',
      });
      setResult(enriched);
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
      submitting.current = false;
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-table font-medium">Enrich a domain</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            {error ? (
              <ErrorState
                error={error}
                layout="inline"
                fieldIdPrefix="intake-single-"
                preserveNotice="Everything you typed is still on this page."
              />
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="intake-single-domain">
                Domain <span className="text-muted-foreground">(required)</span>
              </Label>
              <Input
                id="intake-single-domain"
                required
                placeholder="example.com"
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
              />
              <p className="text-meta text-muted-foreground">
                Bare domain or full URL. The scheme and path are stripped before
                anything is fetched.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="intake-single-company">Company</Label>
                <Input
                  id="intake-single-company"
                  value={company}
                  onChange={(event) => setCompany(event.target.value)}
                />
                <p className="text-meta text-muted-foreground">
                  Supplying it improves entity extraction — names matching the
                  company are excluded from the candidate list.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="intake-single-email">Contact email</Label>
                <Input
                  id="intake-single-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="intake-single-phone">Contact phone</Label>
                <Input
                  id="intake-single-phone"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="intake-single-description">Description</Label>
                <Input
                  id="intake-single-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="intake-single-notes">Internal notes</Label>
              <Textarea
                id="intake-single-notes"
                rows={3}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
              <p className="text-meta text-muted-foreground">
                Operator context, not prospect-facing.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={busy || domain.trim() === ''}>
                <Search aria-hidden="true" className="mr-2 h-4 w-4" />
                {busy ? 'Enriching…' : 'Enrich this domain'}
              </Button>
              <p className="text-meta text-muted-foreground">
                Creates a project, or attaches to the existing one for this
                domain.
              </p>
            </div>
          </form>
        </CardContent>
      </Card>

      <div>
        {busy ? (
          <Skeleton className="h-72 rounded-xl" />
        ) : result ? (
          <EnrichmentResult result={result} />
        ) : (
          <EmptyState
            variant="not-measured"
            subject="enrichment result"
            prerequisite="Submitting the domain on the left."
            layout="panel"
          >
            Nothing has been enriched in this session. The result shows what was
            read from the site and which project it landed in.
          </EmptyState>
        )}
      </div>
    </div>
  );
}

function EnrichmentResult({ result }: { result: IntakeSubjectResult }) {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-table font-medium">{result.domain}</CardTitle>
          <StatusPill
            label={result.created ? 'New project created' : 'Attached to an existing project'}
            tone={result.created ? 'success' : 'info'}
          />
        </div>
        <p className="text-meta text-muted-foreground">
          Read from {result.enrichmentSource === 'both'
            ? 'the homepage and search results'
            : result.enrichmentSource}{' '}
          · {result.pagesFetched} page{result.pagesFetched === 1 ? '' : 's'} fetched
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Field label="Company" value={result.company} />
          <Field label="Category" value={result.category} />
          <Field label="Country" value={result.country} />
          <div className="sm:col-span-2">
            <dt className="text-meta text-muted-foreground">Description</dt>
            <dd className="mt-0.5 text-table">
              {result.description ?? (
                <span className="text-muted-foreground">
                  Nothing was extracted from the site.
                </span>
              )}
            </dd>
          </div>
        </dl>

        <div>
          <h4 className="text-meta font-medium text-muted-foreground">
            Named competitors ({result.competitors.length})
          </h4>
          {result.competitors.length === 0 ? (
            <p className="mt-1 text-table text-muted-foreground">
              None were found. That is a result, not a failure — the page may
              simply not name any.
            </p>
          ) : (
            <ul className="mt-1 space-y-1">
              {result.competitors.map((competitor) => (
                <li key={`${competitor.name}-${competitor.domain ?? ''}`} className="text-table">
                  <span className="font-medium">{competitor.name}</span>
                  {competitor.domain ? (
                    <span className="text-muted-foreground"> · {competitor.domain}</span>
                  ) : null}{' '}
                  {/* Where the name came from is the difference between a claim
                      the site made and one a search result implied. */}
                  <Badge variant="outline" className="text-meta">
                    {competitor.source}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h4 className="text-meta font-medium text-muted-foreground">
            Own entities ({result.ownEntities.length})
          </h4>
          {result.ownEntities.length === 0 ? (
            <p className="mt-1 text-table text-muted-foreground">None were extracted.</p>
          ) : (
            <p className="mt-1 text-table">{result.ownEntities.join(', ')}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
          <span className="text-meta text-muted-foreground">Project</span>
          <span className="font-mono text-meta">{result.projectId}</span>
          <Button variant="outline" size="sm" asChild>
            <a href={`/projects/${result.projectId}`}>
              Open the project
              <ExternalLink aria-hidden="true" className="ml-2 h-3.5 w-3.5" />
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-table">
        {value ?? <span className="text-muted-foreground">Not extracted</span>}
      </dd>
    </div>
  );
}

// ── Bulk ────────────────────────────────────────────────────────────────

const TEMPLATE_HEADERS = ['domain', 'company'];

function BulkIntake() {
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<IntakeBulkResult | null>(null);
  /** Captured when the response arrives, never computed during render — a
   *  `new Date()` in JSX would differ between the server render and hydration. */
  const [receivedAt, setReceivedAt] = useState<string | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  const onFile = useCallback(async (file: File) => {
    setParseError(null);
    setResult(null);
    setFileName(file.name);
    try {
      const text = await file.text();
      const delimiter = file.name.toLowerCase().endsWith('.tsv') ? '\t' : ',';
      const grid = parseDelimited(text, delimiter);
      if (grid.length === 0) {
        setRows([]);
        return;
      }

      const header = grid[0].map((cell) => cell.trim().toLowerCase());
      const hasHeader = header.includes('domain') || header.includes('company');
      const domainIndex = hasHeader ? header.indexOf('domain') : 0;
      const companyIndex = hasHeader ? header.indexOf('company') : 1;

      if (domainIndex === -1) {
        setParseError(
          'The header row has no "domain" column. Rename the column or remove the header so the first column is the domain.',
        );
        setRows([]);
        return;
      }

      const seen = new Map<string, number>();
      const parsed: ParsedRow[] = [];
      for (let index = hasHeader ? 1 : 0; index < grid.length; index += 1) {
        const cells = grid[index];
        if (cells.every((cell) => cell.trim() === '')) continue; // blank line
        const rawDomain = cells[domainIndex] ?? '';
        const domain = normaliseDomain(rawDomain);
        const problem = domainProblem(domain);
        let duplicatedInFile: string | null = null;
        if (!problem) {
          const firstLine = seen.get(domain);
          if (firstLine !== undefined) {
            duplicatedInFile = `Already on line ${firstLine} of this file.`;
          } else {
            seen.set(domain, index + 1);
          }
        }
        parsed.push({
          line: index + 1,
          domain,
          company: (cells[companyIndex] ?? '').trim(),
          problem: problem ?? duplicatedInFile,
        });
      }
      setRows(parsed);
    } catch {
      setParseError('The file could not be read as text.');
      setRows([]);
    }
  }, []);

  const sendable = useMemo(
    () => (rows ?? []).filter((row) => row.problem === null),
    [rows],
  );

  async function onSubmit() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const bulk = await intakeBulk(
        sendable.map((row) => ({
          domain: row.domain,
          company: row.company === '' ? undefined : row.company,
        })),
      );
      setResult(bulk);
      setReceivedAt(new Date().toISOString());
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
      submitting.current = false;
    }
  }

  const columns = useMemo<ReadonlyArray<ColumnDef<ParsedRow>>>(
    () => [
      {
        key: 'line',
        header: 'Line',
        accessor: (row) => row.line,
        sortable: true,
        width: 80,
        align: 'right',
        render: (row) => <span className="tabular-nums">{row.line}</span>,
      },
      {
        key: 'domain',
        header: 'Domain',
        accessor: (row) => row.domain,
        sortable: true,
        render: (row) => (
          <span className={row.problem ? 'text-muted-foreground line-through' : 'font-mono'}>
            {row.domain || '(empty)'}
          </span>
        ),
      },
      {
        key: 'company',
        header: 'Company',
        accessor: (row) => row.company,
        emptyLabel: 'Not supplied',
      },
      {
        key: 'status',
        header: 'Will be sent',
        accessor: (row) => (row.problem ? 'no' : 'yes'),
        sortable: true,
        width: 240,
        render: (row) =>
          row.problem ? (
            <div className="flex items-start gap-2">
              <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 text-warning" />
              <span className="text-meta">{row.problem}</span>
            </div>
          ) : (
            <StatusPill label="Will be sent" tone="success" />
          ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-table font-medium">Preview a list</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-table text-muted-foreground">
            A CSV or TSV with a <code className="font-mono">domain</code> column,
            and optionally a <code className="font-mono">company</code> column.
            The file is read in this browser and nothing is uploaded until you
            submit the preview.
          </p>

          <div className="space-y-2">
            <Label htmlFor="intake-bulk-file">
              File <span className="text-muted-foreground">(CSV or TSV)</span>
            </Label>
            <Input
              id="intake-bulk-file"
              type="file"
              accept=".csv,.tsv,text/csv,text/tab-separated-values"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onFile(file);
              }}
            />
            <p className="text-meta text-muted-foreground">
              Expected header: {TEMPLATE_HEADERS.join(', ')}. A file without a
              header is read as domain in column 1 and company in column 2.
            </p>
          </div>

          {parseError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{parseError}</AlertDescription>
            </Alert>
          ) : null}

          {rows !== null ? (
            <>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
                <Count label="Rows read" value={rows.length} />
                <Count label="Will be sent" value={sendable.length} />
                <Count label="Refused here" value={rows.length - sendable.length} />
                <Count label="Requests" value={1} />
              </dl>
            </>
          ) : null}
        </CardContent>
      </Card>

      {error ? <ErrorState error={error} layout="inline" preserveNotice="Your preview is still here." /> : null}

      {rows === null ? (
        <EmptyState
          variant="not-measured"
          subject="bulk preview"
          prerequisite="Choosing a file above."
          layout="panel"
        >
          Rows are validated in this browser before anything is sent, so an
          invalid or duplicated row is caught here rather than counted as a
          server-side skip.
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState
          variant="not-measured"
          subject="rows in this file"
          prerequisite="A file with at least one domain row."
          layout="panel"
        >
          {fileName ? `${fileName} contained no data rows.` : 'The file contained no data rows.'}
        </EmptyState>
      ) : (
        <>
          <DataTable
            caption="Bulk preview"
            columns={columns}
            rows={rows}
            getRowId={(row) => String(row.line)}
            minTableWidth="48rem"
            defaultSort={{ key: 'line', direction: 'asc' }}
            emptyState={<EmptyState variant="no-results" />}
          />

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void onSubmit()} disabled={busy || sendable.length === 0}>
              <Upload aria-hidden="true" className="mr-2 h-4 w-4" />
              {busy
                ? 'Enriching…'
                : `Enrich ${sendable.length} domain${sendable.length === 1 ? '' : 's'}`}
            </Button>
            <p className="text-meta text-muted-foreground">
              {sendable.length - 1 > 0
                ? `This spends ${sendable.length} enrichments in one request and is limited to 2 a minute.`
                : 'One enrichment, limited to 2 a minute.'}{' '}
              Rows with a problem are not sent.
            </p>
          </div>
        </>
      )}

      {result && receivedAt ? <BulkResult result={result} receivedAt={receivedAt} /> : null}
    </div>
  );
}

/**
 * What the bulk response supports, and where it stops.
 *
 * `created` is a count of newly created projects; `enriched` rows carry no
 * project id, so a per-row "created or attached" verdict cannot be derived and
 * is not shown. Saying that here is the point — a screen that guessed would be
 * inventing the one fact an operator would act on.
 */
function BulkResult({ result, receivedAt }: { result: IntakeBulkResult; receivedAt: string }) {
  const skippedCount = result.skipped.length;
  const attached = result.submitted - result.created - skippedCount;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-table font-medium">Bulk result</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          <Count label="Submitted" value={result.submitted} />
          <Count label="New projects" value={result.created} />
          <Count label="Attached to existing" value={Math.max(attached, 0)} />
          <Count label="Skipped by the server" value={skippedCount} />
        </dl>
        <p className="text-meta text-muted-foreground">
          The bulk response reports newly created projects as a count and does
          not carry a project id per row, so which specific rows attached to an
          existing project cannot be told from this response. The single-domain
          tab reports that per row.
        </p>

        {skippedCount > 0 ? (
          <div>
            <h4 className="text-table font-medium">
              Skipped rows ({skippedCount})
            </h4>
            <p className="mt-1 text-meta text-muted-foreground">
              These were refused during enrichment. They are listed rather than
              silently dropped — reasons are truncated by the server.
            </p>
            <ul className="mt-2 space-y-1">
              {result.skipped.map((row) => (
                <li key={`${row.domain}-${row.reason}`} className="text-table">
                  <span className="font-mono">{row.domain}</span>{' '}
                  <span className="text-muted-foreground">— {row.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-success" />
            <p className="text-table">
              No rows were refused. That is not a statement about data quality —
              only that every item was fetched and extracted.
            </p>
          </div>
        )}

        {result.enriched.length > 0 ? (
          <div>
            <h4 className="text-table font-medium">
              Enriched rows ({result.enriched.length})
            </h4>
            <ul className="mt-2 space-y-1">
              {result.enriched.map((row) => (
                <li key={row.domain} className="text-table">
                  <span className="font-mono">{row.domain}</span>
                  {row.company ? <span className="text-muted-foreground"> · {row.company}</span> : null}
                  {row.category ? (
                    <span className="text-muted-foreground"> · {row.category}</span>
                  ) : null}
                  <span className="text-meta text-muted-foreground">
                    {' '}
                    · {row.pagesFetched} page{row.pagesFetched === 1 ? '' : 's'} ·{' '}
                    {row.competitors.length} competitor
                    {row.competitors.length === 1 ? '' : 's'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="text-meta text-muted-foreground">
          Received <Timestamp value={receivedAt} /> — the time this page read the
          response. The server does not return a per-row completion time for
          bulk intake, so no per-row timing is shown.
        </p>
      </CardContent>
    </Card>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="text-table tabular-nums font-medium">{value}</dd>
    </div>
  );
}
