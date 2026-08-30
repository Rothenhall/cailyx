# Fetcher Module — API Reference

> **⚠️ Internal module — no REST endpoints exposed.**
>
> The fetcher is a NestJS service injected via dependency injection into other modules.
> It is NOT accessible via HTTP. Other modules call its methods directly.

## Public Service Methods

These methods are available to any module that imports `FetcherModule`:

| Method | Signature | Description |
|---|---|---|
| `fetch()` | `fetch(opts: FetchOptions, calledBy?: string, runId?: string) → Promise<FetchResult>` | Raw HTTP GET/POST with custom User-Agent, caching, rate limiting, retry |
| `probe()` | `probe(opts: ProbeOptions, calledBy?: string, runId?: string) → Promise<ProbeResult>` | Access probe — sends requests with AI bot UA, repeats N times, reports stable result + flapping |
| `render()` | `render(opts: RenderOptions, calledBy?: string, runId?: string) → Promise<RenderResult>` | Headless browser render with optional JS disabled (Playwright) |
| `fetchSchema()` | `fetchSchema(url: string, calledBy?: string, runId?: string) → Promise<SchemaResult>` | Extract JSON-LD structured data from a page |
| `verifyUrl()` | `verifyUrl(opts: VerifyUrlOptions, calledBy?: string, runId?: string) → Promise<VerifyUrlResult>` | Resolve a URL and check identity match (for sameAs verification) |
| `callPsiApi()` | `callPsiApi(url: string, calledBy?: string, runId?: string) → Promise<PsiResult>` | Call Google PageSpeed Insights API for Core Web Vitals |
| `getLogs()` | `getLogs() → FetchLogEntry[]` | Get all fetch operation logs |
| `getLogsByRun()` | `getLogsByRun(runId: string) → FetchLogEntry[]` | Get logs for a specific run |
| `getRunCost()` | `getRunCost(runId: string) → number` | Get total cost for a run |

## Usage Example (in another module)

```typescript
import { FetcherService } from '../fetcher/fetcher.service';

@Injectable()
export class MyService {
  constructor(private readonly fetcher: FetcherService) {}

  async checkSite(url: string) {
    // Fetch with a specific AI bot User-Agent
    const result = await this.fetcher.fetch({
      url,
      userAgent: 'Mozilla/5.0 ... GPTBot/1.2',
    }, 'my-module', 'run_123');

    // Probe with 3 repeats for determinism
    const probe = await this.fetcher.probe({
      url,
      userAgent: 'Mozilla/5.0 ... ClaudeBot/1.0',
      botName: 'ClaudeBot',
      repeat: 3,
    }, 'my-module', 'run_123');

    // Render with JS disabled
    const rendered = await this.fetcher.render({
      url,
      jsDisabled: true,
    }, 'my-module', 'run_123');
  }
}
```

## Security

- **SSRF guard:** All HTTP requests are checked against private IP ranges (127.0.0.1, 10/8, 172.16/12, 192.168/16, 169.254/16). Blocked silently.
- **Rate limiting:** Per-domain (3s between requests) + global (10/s). Prevents hammering client sites.
- **Circuit breaker:** 5 consecutive failures per domain → 60s pause.
- **Cost tracking:** Per-run cost budget enforcement for paid API calls.