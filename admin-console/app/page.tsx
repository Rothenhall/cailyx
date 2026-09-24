"use client";

import { useEffect, useState } from "react";
import {
  ApiError,
  login,
  findOrCreateProject,
  runDiagnostics,
  generateReport,
  downloadReportPdf,
  previewPromptMatrix,
  runAeoAudit,
  runCompetitorAnalysis,
  type CompetitorResolveResult,
  type MatrixSummary,
  type GeneratedReport,
} from "@/lib/api";

const TOKEN_KEY = "cailyx_admin_token";

const MATRIX_TIERS = ["trial", "trial-wide", "scorecard", "standard", "full"] as const;

type ActionKey = "diagnostics" | "report" | "preview" | "aeo" | "competitors";

interface ActionState {
  running: boolean;
  log: string[];
  error: string | null;
  done: boolean;
}

const emptyAction: ActionState = { running: false, log: [], error: null, done: false };

export default function Home() {
  const [token, setToken] = useState<string | null>(null);
  const [checkedStorage, setCheckedStorage] = useState(false);

  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  const [domainInput, setDomainInput] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [project, setProject] = useState<{ projectId: string; domain: string } | null>(null);

  const [actions, setActions] = useState<Record<ActionKey, ActionState>>({
    diagnostics: emptyAction,
    report: emptyAction,
    preview: emptyAction,
    aeo: emptyAction,
    competitors: emptyAction,
  });
  const [diagnosticsRan, setDiagnosticsRan] = useState(false);
  const [reports, setReports] = useState<GeneratedReport[]>([]);
  const [competitorResult, setCompetitorResult] = useState<CompetitorResolveResult | null>(null);
  const [promptMatrix, setPromptMatrix] = useState<MatrixSummary | null>(null);
  const [matrixTier, setMatrixTier] = useState<string>("trial");

  useEffect(() => {
    // Reads an external system (localStorage) once on mount to sync this
    // component's auth state — hydration-safe (server has no localStorage,
    // so the initial render must stay null-token until the client checks).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToken(localStorage.getItem(TOKEN_KEY));
    setCheckedStorage(true);
  }, []);

  function updateAction(key: ActionKey, patch: Partial<ActionState>) {
    setActions((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  function appendLog(key: ActionKey, line: string) {
    setActions((prev) => ({ ...prev, [key]: { ...prev[key], log: [...prev[key].log, line] } }));
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError(null);
    setLoggingIn(true);
    try {
      const t = await login(loginEmail, loginPassword);
      localStorage.setItem(TOKEN_KEY, t);
      setToken(t);
    } catch (err) {
      setLoginError(err instanceof ApiError ? err.message : "Login failed.");
    } finally {
      setLoggingIn(false);
    }
  }

  function handleLogout() {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setProject(null);
    setActions({ diagnostics: emptyAction, report: emptyAction, preview: emptyAction, aeo: emptyAction, competitors: emptyAction });
    setDiagnosticsRan(false);
    setReports([]);
    setCompetitorResult(null);
    setPromptMatrix(null);
  }

  async function handleResolveProject(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setResolveError(null);
    setResolving(true);
    setProject(null);
    setActions({ diagnostics: emptyAction, report: emptyAction, preview: emptyAction, aeo: emptyAction, competitors: emptyAction });
    setDiagnosticsRan(false);
    setReports([]);
    setCompetitorResult(null);
    setPromptMatrix(null);
    try {
      const p = await findOrCreateProject(domainInput, token);
      setProject({ projectId: p.projectId, domain: p.domain });
    } catch (err) {
      setResolveError(err instanceof ApiError ? err.message : "Could not resolve that domain.");
    } finally {
      setResolving(false);
    }
  }

  async function handleRunDiagnostics() {
    if (!token || !project) return;
    updateAction("diagnostics", { running: true, error: null, log: [], done: false });
    try {
      await runDiagnostics(project.projectId, project.domain, token, (msg) => appendLog("diagnostics", msg));
      setDiagnosticsRan(true);
      updateAction("diagnostics", { running: false, done: true });
    } catch (err) {
      updateAction("diagnostics", { running: false, error: err instanceof ApiError ? err.message : "Failed." });
    }
  }

  async function handleGenerateReport() {
    if (!token || !project) return;
    updateAction("report", { running: true, error: null, log: [], done: false });
    try {
      const report = await generateReport(project.projectId, project.domain, token, (msg) => appendLog("report", msg));
      setReports((prev) => [report, ...prev]);
      updateAction("report", { running: false, done: true });
    } catch (err) {
      updateAction("report", { running: false, error: err instanceof ApiError ? err.message : "Failed." });
    }
  }

  async function handleDownload(slug: string) {
    if (!token || !project) return;
    try {
      await downloadReportPdf(project.projectId, slug, token, `${project.domain}-${slug}.pdf`);
    } catch (err) {
      updateAction("report", { error: err instanceof ApiError ? err.message : "Download failed." });
    }
  }

  async function handlePreviewMatrix() {
    if (!token || !project) return;
    updateAction("preview", { running: true, error: null, log: [], done: false });
    setPromptMatrix(null);
    try {
      const matrix = await previewPromptMatrix(project.projectId, token, matrixTier, (msg) => appendLog("preview", msg));
      setPromptMatrix(matrix);
      updateAction("preview", { running: false, done: true });
    } catch (err) {
      updateAction("preview", { running: false, error: err instanceof ApiError ? err.message : "Failed." });
    }
  }

  async function handleRunAeo() {
    if (!token || !project) return;
    updateAction("aeo", { running: true, error: null, log: [], done: false });
    try {
      const { matrix } = await runAeoAudit(project.projectId, token, (msg) => appendLog("aeo", msg), matrixTier);
      if (matrix) setPromptMatrix(matrix);
      updateAction("aeo", { running: false, done: true });
    } catch (err) {
      updateAction("aeo", { running: false, error: err instanceof ApiError ? err.message : "Failed." });
    }
  }

  async function handleRunCompetitors() {
    if (!token || !project) return;
    updateAction("competitors", { running: true, error: null, log: [], done: false });
    try {
      const result = await runCompetitorAnalysis(project.projectId, token, (msg) => appendLog("competitors", msg));
      setCompetitorResult(result);
      updateAction("competitors", { running: false, done: true });
    } catch (err) {
      updateAction("competitors", { running: false, error: err instanceof ApiError ? err.message : "Failed." });
    }
  }

  if (!checkedStorage) {
    return (
      <main>
        <h1>Cailyx Admin Console</h1>
      </main>
    );
  }

  if (!token) {
    return (
      <main>
        <h1>Cailyx Admin Console</h1>
        <p className="subtitle">Staff login required.</p>
        <form className="panel" onSubmit={handleLogin}>
          {loginError && <div className="error-banner">{loginError}</div>}
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={loginEmail}
            onChange={(e) => setLoginEmail(e.target.value)}
            required
            style={{ marginBottom: 14 }}
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
            required
            style={{ marginBottom: 18 }}
          />
          <button type="submit" disabled={loggingIn}>
            {loggingIn ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main>
      <div className="project-header">
        <h1>Cailyx Admin Console</h1>
        <button className="secondary" onClick={handleLogout}>
          Sign out
        </button>
      </div>
      <p className="subtitle">Enter a site, run diagnostics, download the results.</p>

      <form className="panel" onSubmit={handleResolveProject}>
        <label htmlFor="domain">Website</label>
        <div className="row">
          <input
            id="domain"
            type="text"
            placeholder="example.com"
            value={domainInput}
            onChange={(e) => setDomainInput(e.target.value)}
            required
          />
          <button type="submit" disabled={resolving}>
            {resolving ? "Loading…" : "Go"}
          </button>
        </div>
        {resolveError && (
          <div className="error-banner" style={{ marginTop: 12, marginBottom: 0 }}>
            {resolveError}
          </div>
        )}
      </form>

      {project && (
        <div className="panel">
          <div className="project-header">
            <h2>{project.domain}</h2>
            <span className="badge">project ready</span>
          </div>

          <div className="actions">
            <ActionRow
              title="1. Run Diagnostics"
              description="Technical audit, presence, tech stack, competitors, gaps, strategy, findings. Stores everything in the DB. Run once — re-run later to refresh with fresh data."
              state={actions.diagnostics}
              onRun={handleRunDiagnostics}
              extra={diagnosticsRan ? <span className="badge">data in DB</span> : null}
            />
            <ActionRow
              title="2. Generate Report"
              description="Reads whatever's currently stored and assembles a report — does not re-run diagnostics. Call it again any time for another report version from the same data."
              state={actions.report}
              onRun={handleGenerateReport}
              disabled={!diagnosticsRan}
            />
            <div className="action-card">
              <div>
                <h3>AEO prompt matrix tier</h3>
                <p>Controls both the preview below and the audit&apos;s actual run — trial=5, trial-wide=10, scorecard=25, standard=100, full=300 prompts.</p>
              </div>
              <select
                value={matrixTier}
                onChange={(e) => setMatrixTier(e.target.value)}
                disabled={actions.preview.running || actions.aeo.running}
                style={{ flexShrink: 0 }}
              >
                {MATRIX_TIERS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <ActionRow
              title="3. Preview Prompt Buckets"
              description="Generates and shows every prompt the audit would run — no engine calls, no spend. Review before committing to the real audit."
              state={actions.preview}
              onRun={handlePreviewMatrix}
              disabled={!diagnosticsRan}
            />
            <ActionRow
              title="4. Run AEO Audit"
              description="Answer-engine audit across ChatGPT, Gemini and Perplexity, using the tier above. Real, metered spend."
              state={actions.aeo}
              onRun={handleRunAeo}
            />
            <ActionRow
              title="5. Competitor Analysis"
              description="Market-search discovery, then resolves the AEO-ranked names into profiled competitors."
              state={actions.competitors}
              onRun={handleRunCompetitors}
              extra={
                competitorResult && competitorResult.resolved.length > 0 ? (
                  <span className="badge">{competitorResult.resolved.length} resolved</span>
                ) : null
              }
            />
          </div>

          {reports.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <label>Generated reports ({reports.length})</label>
              <div className="actions">
                {reports.map((r) => (
                  <div key={r.slug} className="action-card">
                    <div>
                      <h3 style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{r.slug}</h3>
                      <p>{new Date(r.createdAt).toLocaleString()}</p>
                    </div>
                    <button className="secondary" onClick={() => handleDownload(r.slug)}>
                      Download PDF
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {competitorResult && competitorResult.resolved.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <label>Resolved competitors</label>
              <div className="status-log" style={{ maxHeight: "none" }}>
                {competitorResult.resolved.map((c) => `${c.name} — ${c.domain ?? "domain not found"}`).join("\n")}
              </div>
            </div>
          )}

          {promptMatrix && (
            <div style={{ marginTop: 16 }}>
              <label>
                Prompt buckets ({promptMatrix.promptCount} prompts, {promptMatrix.tier} tier)
              </label>
              {promptMatrix.byDimension.map((bucket) => (
                <div key={bucket.dimension} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 13, marginBottom: 4 }}>
                    <strong>{bucket.label}</strong>{" "}
                    <span className="badge">
                      {bucket.count} · {bucket.branded} branded / {bucket.unbranded} unbranded
                    </span>
                  </div>
                  <div className="status-log" style={{ maxHeight: "none" }}>
                    {bucket.prompts.map((p) => p.prompt).join("\n")}
                  </div>
                </div>
              ))}
              {promptMatrix.skipped.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <label>Skipped dimensions</label>
                  <div className="status-log" style={{ maxHeight: "none" }}>
                    {promptMatrix.skipped.map((s) => `${s.dimension}: ${s.reason}`).join("\n")}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </main>
  );
}

function ActionRow({
  title,
  description,
  state,
  onRun,
  extra,
  disabled,
}: {
  title: string;
  description: string;
  state: ActionState;
  onRun: () => void;
  extra?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div>
      <div className="action-card">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <div className="row" style={{ flexShrink: 0 }}>
          {extra}
          <button onClick={onRun} disabled={state.running || disabled} title={disabled ? "Run diagnostics first" : undefined}>
            {state.running ? "Running…" : state.done ? "Run again" : "Run"}
          </button>
        </div>
      </div>
      {(state.log.length > 0 || state.error) && (
        <div className="status-log" style={{ marginTop: 8 }}>
          {state.log.map((line, i) => (
            <div key={i} className={i === state.log.length - 1 && !state.error ? "line-current" : ""}>
              {line}
            </div>
          ))}
          {state.error && <div className="line-error">Error: {state.error}</div>}
          {state.done && !state.error && <div className="line-done">✓ Done</div>}
        </div>
      )}
    </div>
  );
}
