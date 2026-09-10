/**
 * Agent-readiness check — Vercel / Ora's `is-agentic` score.
 *
 * Two paths, in this order:
 *
 *   1. the CLI (`npx is-agentic <host> --json`) — the ONLY interface that can
 *      start a scan. It returns a stored report immediately, or kicks off a
 *      fresh scan and waits (~30s cold).
 *   2. the read-only HTTP API — instant, but 404s with `report_not_found`
 *      until someone has scanned that URL. Used as the fallback when the CLI
 *      is unavailable (no network egress for npm, npx disabled, timeout).
 *
 * Two things to know before touching this:
 *
 * - `execFile` with an argument array, never `exec` with a command string.
 *   The host reaches this from a request body, so string interpolation into a
 *   shell would be a command-injection sink. The host is additionally
 *   validated against `SAFE_HOST` below, which admits only alphanumerics,
 *   hyphens and dots — no metacharacter survives it.
 *
 *   On Windows this needs care. `npx` is `npx.cmd`, a batch file, and since
 *   the fix for CVE-2024-27980 Node refuses to spawn `.cmd`/`.bat` without a
 *   shell — you get `spawn EINVAL`. The workaround is NOT `shell: true`
 *   (which would take a single interpolated command string, the exact sink we
 *   are avoiding); it is to invoke the interpreter explicitly and keep passing
 *   arguments as an array.
 * - the scan and its report page are PUBLIC. is-agentic publishes results at
 *   is-agentic.com/scan/<domain>. That is inherent to the tool, not something
 *   this module can opt out of, so it is off by default for any host that is
 *   not the project's own domain.
 *
 * @module technical-audit/checks/agent-readiness
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import type { AgentReadinessAnalysis, AgentReadinessIssue } from '../technical-audit.types';

const API_BASE = 'https://is-agentic.com/api/v1/report';

/**
 * Hostnames only: labels of alphanumerics and hyphens, dot-separated. No
 * scheme, path, port, credentials, whitespace or shell metacharacters can
 * survive this, which is what makes it safe to hand to a spawned process.
 */
const SAFE_HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

@Injectable()
export class AgentReadinessCheckService {
  private readonly logger = new Logger(AgentReadinessCheckService.name);

  constructor(private readonly config: ConfigService) {}

  private get cliEnabled(): boolean {
    // Opt-out rather than opt-in: the check is worthless without the CLI,
    // since the API cannot start a scan.
    return this.config.get<string>('AGENT_READINESS_CLI', 'true') !== 'false';
  }

  private get timeoutMs(): number {
    return Number(this.config.get('AGENT_READINESS_TIMEOUT_MS', 180_000)) || 180_000;
  }

  /** Never throws — an unavailable scanner is a `not-run` finding, not a failure. */
  async analyze(targetUrl: string): Promise<AgentReadinessAnalysis> {
    const empty = (error: string | null, source: AgentReadinessAnalysis['source'] = 'none'): AgentReadinessAnalysis => ({
      score: null,
      scoreLabel: null,
      target: null,
      reportUrl: null,
      scannedAt: null,
      eligibleChecks: null,
      breakdown: null,
      issues: [],
      source,
      error,
    });

    let host: string;
    try {
      host = new URL(targetUrl).hostname;
    } catch {
      return empty('Target URL could not be parsed');
    }
    if (!SAFE_HOST.test(host)) {
      return empty(`Refusing to scan a non-public hostname: ${host}`);
    }

    if (this.cliEnabled) {
      const viaCli = await this.runCli(host);
      if (viaCli) return viaCli;
    }

    const viaApi = await this.readApi(targetUrl, host);
    if (viaApi) return viaApi;

    return empty(
      this.cliEnabled
        ? 'is-agentic returned no report (the CLI failed or timed out, and no stored report exists)'
        : 'is-agentic CLI is disabled and no stored report exists for this URL',
    );
  }

  // ─── path 1: the CLI (can start a scan) ───────────────────────

  private runCli(host: string): Promise<AgentReadinessAnalysis | null> {
    return new Promise((resolve) => {
      const started = Date.now();
      const [cmd, args] = this.cliInvocation(host);
      execFile(
        cmd,
        args,
        {
          timeout: this.timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
          // No shell. See the module note.
          shell: false,
          env: { ...process.env, NO_COLOR: '1', CI: '1' },
        },
        (err, stdout) => {
          const ms = Date.now() - started;
          if (err && !stdout) {
            this.logger.warn(`is-agentic CLI failed after ${ms}ms: ${err.message}`);
            return resolve(null);
          }
          const parsed = this.parse(stdout, 'cli');
          if (!parsed) {
            this.logger.warn(`is-agentic CLI returned unparseable output after ${ms}ms`);
            return resolve(null);
          }
          this.logger.log(`is-agentic scored ${host} at ${parsed.score} in ${ms}ms`);
          resolve(parsed);
        },
      );
    });
  }

  /**
   * How to invoke npx on this platform, as [command, args].
   *
   * POSIX spawns `npx` directly. Windows routes through the command
   * interpreter because `npx` is a batch shim — `/d` skips AutoRun scripts and
   * `/s` fixes the interpreter's quote handling to a single predictable rule.
   * Arguments stay a real array either way, so nothing is string-interpolated.
   */
  private cliInvocation(host: string): [string, string[]] {
    const args = ['--yes', 'is-agentic@latest', host, '--json'];
    if (process.platform !== 'win32') return ['npx', args];
    return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npx', ...args]];
  }

  // ─── path 2: the read-only API (cannot start a scan) ──────────

  private async readApi(targetUrl: string, host: string): Promise<AgentReadinessAnalysis | null> {
    // The API keys on the exact URL string, so a report stored for
    // "https://example.com" is not found under "https://example.com/". Try the
    // literal target first, then the bare origin.
    const attempts = this.dedupe([targetUrl, `https://${host}`]);
    for (const url of attempts) {
      try {
        const res = await fetch(`${API_BASE}?url=${encodeURIComponent(url)}`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) continue;
        const parsed = this.parse(await res.text(), 'api');
        if (parsed) return parsed;
      } catch {
        // fall through to the next attempt
      }
    }
    return null;
  }

  // ─── shared ───────────────────────────────────────────────────

  private dedupe(xs: string[]): string[] {
    return [...new Set(xs)];
  }

  /**
   * The CLI prints JSON on stdout under `--json`, but npx can prepend install
   * chatter, so the payload is located rather than assumed to start at byte 0.
   */
  private parse(raw: string, source: 'cli' | 'api'): AgentReadinessAnalysis | null {
    if (!raw) return null;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;

    let d: Record<string, unknown>;
    try {
      d = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
    if (typeof d.score !== 'number') return null;

    const issues: AgentReadinessIssue[] = Array.isArray(d.issues)
      ? (d.issues as Array<Record<string, unknown>>).map((i) => ({
          id: String(i.id ?? ''),
          name: String(i.name ?? ''),
          result: String(i.result ?? ''),
          recommendation: String(i.recommendation ?? ''),
          details: i.details ? String(i.details) : undefined,
        }))
      : [];

    return {
      score: d.score,
      scoreLabel: typeof d.score_label === 'string' ? d.score_label : null,
      target: typeof d.target === 'string' ? d.target : null,
      reportUrl: typeof d.report_url === 'string' ? d.report_url : null,
      scannedAt: typeof d.scanned_at === 'string' ? d.scanned_at : null,
      eligibleChecks: typeof d.eligible_checks === 'number' ? d.eligible_checks : null,
      breakdown: (d.score_breakdown as AgentReadinessAnalysis['breakdown']) ?? null,
      issues,
      source,
      error: null,
    };
  }
}
