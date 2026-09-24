/**
 * Thin client for the existing Cailyx backend — no new backend endpoints,
 * this only calls what already exists (technical-audit, digital-presence,
 * tech-stack, competitors, gap-analysis, strategy, findings, reporting, and
 * AEO audit). Each `run*` function orchestrates the same sequence an
 * operator would otherwise call by hand, and reports progress through
 * `onProgress` so the UI can show a live log.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3002/api';

export class ApiError extends Error {}

export type Progress = (message: string) => void;

async function request<T>(path: string, token: string | null, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.message) message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
    } catch {
      // body wasn't JSON — keep the status text
    }
    throw new ApiError(message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Auth ────────────────────────────────────────────────────────────────

export async function login(email: string, password: string): Promise<string> {
  const data = await request<{ accessToken: string; user: { role: string; type: string } }>('/auth/login', null, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (data.user.type !== 'operator') {
    throw new ApiError('This account is a client login, not a staff/operator login.');
  }
  return data.accessToken;
}

// ─── Project resolution ─────────────────────────────────────────────────

function normalizeDomain(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
}

export async function findOrCreateProject(urlOrDomain: string, token: string): Promise<{ projectId: string; domain: string; created: boolean }> {
  const domain = normalizeDomain(urlOrDomain);
  if (!domain) throw new ApiError('Enter a domain or URL first.');
  const result = await request<{ projectId: string; domain: string; created: boolean }>('/intake/subject', token, {
    method: 'POST',
    body: JSON.stringify({ domain }),
  });
  return result;
}

// ─── Polling helpers ─────────────────────────────────────────────────────

async function pollUntil<T>(
  fetchStatus: () => Promise<T>,
  isDone: (v: T) => boolean,
  isFailed: (v: T) => boolean,
  describe: (v: T) => string,
  onProgress: Progress,
  intervalMs = 8000,
  maxWaitMs = 45 * 60 * 1000,
): Promise<T> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const status = await fetchStatus();
    onProgress(describe(status));
    if (isDone(status)) return status;
    if (isFailed(status)) throw new ApiError(describe(status));
    if (Date.now() > deadline) throw new ApiError('Timed out waiting for this stage — it may still finish in the background.');
    await sleep(intervalMs);
  }
}

// ─── Diagnostics — populates the DB, run once (or re-run to refresh) ─────

/**
 * Runs every audit stage and stores its results. Does NOT generate a report
 * — that's `generateReport` below, a separate, fast, repeatable action that
 * reads whatever this left in the DB. Nothing here is lost or re-fetched by
 * that step; each stage already writes its own real rows (TechnicalAudit,
 * PresenceAccount, Competitor, GapAnalysis, ActionPlan, Finding, ...) the
 * moment it runs, independent of whether a report ever gets generated.
 */
export async function runDiagnostics(projectId: string, domain: string, token: string, onProgress: Progress): Promise<void> {
  const targetUrl = `https://${domain}`;

  onProgress('Running technical audit…');
  const auditQueued = await request<{ jobId: string }>(`/projects/${projectId}/technical-audit/run`, token, {
    method: 'POST',
    body: JSON.stringify({ targetUrl }),
  });
  await pollUntil(
    () => request<{ status: string; error?: string }>(`/projects/${projectId}/technical-audit/run/jobs/${auditQueued.jobId}`, token),
    (s) => s.status === 'completed',
    (s) => s.status === 'failed',
    (s) => `Technical audit: ${s.status}${s.error ? ` — ${s.error}` : ''}`,
    onProgress,
  );

  onProgress('Discovering digital presence…');
  const presence = await request<{ id: string; status: string }>(`/projects/${projectId}/presence/discover`, token, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  await pollUntil(
    () => request<{ status: string }>(`/projects/${projectId}/presence/discoveries/${presence.id}`, token),
    (s) => s.status === 'completed',
    (s) => s.status === 'failed',
    (s) => `Digital presence: ${s.status}`,
    onProgress,
  );

  onProgress('Scanning tech stack…');
  await request(`/projects/${projectId}/tech-stack/scan`, token, { method: 'POST', body: JSON.stringify({}) });

  onProgress('Discovering competitors…');
  await request(`/projects/${projectId}/competitors/discover`, token, { method: 'POST', body: JSON.stringify({}) });

  onProgress('Syncing gap analysis…');
  await request(`/projects/${projectId}/gap-analysis/sync`, token, { method: 'POST' });

  onProgress('Building strategy / action plan…');
  await request(`/projects/${projectId}/strategy/build`, token, { method: 'POST' });

  onProgress('Generating findings copy…');
  await request(`/projects/${projectId}/findings/generate`, token, { method: 'POST', body: JSON.stringify({ limit: 5 }) });

  onProgress('Diagnostics complete — everything above is now in the DB.');
}

// ─── Report generation — reads the DB, never re-runs diagnostics ────────

export interface GeneratedReport {
  slug: string;
  createdAt: string;
}

/**
 * Reads whatever `runDiagnostics` (or an earlier run of it) already put in
 * the DB and assembles a report from it — the backend's own generate-report
 * endpoint is already a pure read-and-compose over the latest stored
 * technical-audit/entity-audit/gap-analysis rows; it never re-scrapes or
 * re-runs anything itself. Callable repeatedly: each call makes a new
 * Report row (new slug), so you can generate several report snapshots from
 * the same underlying data without paying for diagnostics again.
 *
 * Left as an unpublished draft — never reviewed/approved/published, so it
 * never reaches the client portal or the client's official report history.
 */
export async function generateReport(projectId: string, domain: string, token: string, onProgress: Progress): Promise<GeneratedReport> {
  onProgress('Generating report from stored data (no diagnostics re-run)…');
  const report = await request<{ slug: string }>(`/projects/${projectId}/reports`, token, {
    method: 'POST',
    body: JSON.stringify({ targetUrl: `https://${domain}`, title: `${domain} — Day 1 Audit` }),
  });
  onProgress('Report ready (draft — not published to the client).');
  return { slug: report.slug, createdAt: new Date().toISOString() };
}

export async function downloadReportPdf(projectId: string, slug: string, token: string, filename: string): Promise<void> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/reports/${slug}/render.pdf`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new ApiError(`Could not download report (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ─── AEO audit ───────────────────────────────────────────────────────────

export interface PromptBucket {
  dimension: string;
  label: string;
  count: number;
  branded: number;
  unbranded: number;
  prompts: Array<{ id: string; prompt: string; dimension: string; funnelStage: string }>;
}

export interface MatrixSummary {
  querySetId: string;
  tier: string;
  promptCount: number;
  byDimension: PromptBucket[];
  skipped: Array<{ dimension: string; reason: string }>;
}

export async function getPromptMatrix(projectId: string, querySetId: string, token: string): Promise<MatrixSummary> {
  return request<MatrixSummary>(`/projects/${projectId}/aeo/matrix/${querySetId}`, token);
}

/**
 * Generates and returns the prompt matrix WITHOUT running the audit — no
 * engine measurement, no per-answer LLM spend. Lets the operator review
 * every bucket and prompt the real run would use before committing to it.
 *
 * The matrix is built from a site context (what the client sells, who buys
 * it) that `runDiagnostics` does not create — only the full AEO audit does,
 * internally. So this builds that context first if none exists yet (a real
 * crawl of the client's own site, no third-party engine spend), then
 * generates the matrix from it.
 */
export async function previewPromptMatrix(
  projectId: string,
  token: string,
  tier: string,
  onProgress: Progress,
): Promise<MatrixSummary> {
  const hasContext = await request<unknown>(`/projects/${projectId}/aeo/context`, token).then(
    () => true,
    () => false,
  );

  if (!hasContext) {
    onProgress('No site context yet — crawling the site to build one…');
    const job = await request<{ jobId: string }>(`/projects/${projectId}/aeo/context`, token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await pollUntil(
      () => request<{ status: string; error?: string }>(`/projects/${projectId}/aeo/context/jobs/${job.jobId}`, token),
      (s) => s.status === 'completed',
      (s) => s.status === 'failed',
      (s) => `Site context: ${s.status}${s.error ? ` — ${s.error}` : ''}`,
      onProgress,
    );
  }

  onProgress(`Generating the ${tier} prompt matrix for review…`);
  const matrix = await request<MatrixSummary>(`/projects/${projectId}/aeo/matrix`, token, {
    method: 'POST',
    body: JSON.stringify({ tier }),
  });
  onProgress(`Matrix ready — ${matrix.promptCount} prompt(s) across ${matrix.byDimension.length} bucket(s).`);
  return matrix;
}

export async function runAeoAudit(
  projectId: string,
  token: string,
  onProgress: Progress,
  tier: string = 'trial',
): Promise<{ auditId: string; verdict: unknown; matrix: MatrixSummary | null }> {
  onProgress(`Starting AEO audit (ChatGPT, Gemini, Perplexity — ${tier} tier)…`);
  const audit = await request<{ id: string }>(`/projects/${projectId}/aeo/audits/full`, token, {
    method: 'POST',
    body: JSON.stringify({ surfaces: ['cloro-chatgpt', 'cloro-perplexity', 'cloro-gemini'], tier, runCount: 5 }),
  });

  const final = await pollUntil(
    () => request<{ status: string; observations: number; costUsd: number; error?: string; verdict: unknown; querySetId: string | null }>(
      `/projects/${projectId}/aeo/audits/${audit.id}`,
      token,
    ),
    (s) => s.status === 'completed',
    (s) => s.status === 'failed',
    (s) => `AEO audit: ${s.status} (${s.observations} observations, $${s.costUsd.toFixed(3)})${s.error ? ` — ${s.error}` : ''}`,
    onProgress,
    10000,
  );

  let matrix: MatrixSummary | null = null;
  if (final.querySetId) {
    onProgress('Loading the prompt matrix used for this audit…');
    matrix = await getPromptMatrix(projectId, final.querySetId, token);
  }

  onProgress('AEO audit complete.');
  return { auditId: audit.id, verdict: final.verdict, matrix };
}

// ─── Competitor analysis ────────────────────────────────────────────────

export interface CompetitorResolveResult {
  totalCompetitors: number;
  promoted: number;
  resolved: Array<{ name: string; domain: string | null }>;
  competitors: Array<{ name: string; domain: string; latestProfile?: { seoScore?: number | null } }>;
}

export async function runCompetitorAnalysis(projectId: string, token: string, onProgress: Progress): Promise<CompetitorResolveResult> {
  onProgress('Searching for market competitors…');
  await request(`/projects/${projectId}/competitors/discover/market`, token, {
    method: 'POST',
    body: JSON.stringify({ collectNew: true }),
  });

  onProgress('Resolving ranked competitors from the latest AEO audit (if any)…');
  const resolved = await request<CompetitorResolveResult>(`/projects/${projectId}/competitors/ranking/resolve`, token, {
    method: 'POST',
    body: JSON.stringify({}),
  });

  onProgress(`Done — ${resolved.promoted ?? resolved.totalCompetitors ?? 0} competitor(s) tracked.`);
  return resolved;
}
