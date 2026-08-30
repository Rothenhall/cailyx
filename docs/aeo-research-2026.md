# AEO & AI Crawler Research — August 2026

## Key findings for technical-audit module

### 1. AI Crawler Bot List (25+ bots, 19 companies)
Source: crawlytics.app, geoprompttracker.com, heybuffy.com — June/July 2026

**Three categories of bots:**
- **Training crawlers** — fetch content for model training (GPTBot, ClaudeBot, Bytespider, etc.)
- **Search/index crawlers** — feed AI search products (OAI-SearchBot, PerplexityBot, Claude-SearchBot)
- **Live-fetch agents** — user-triggered real-time fetches (ChatGPT-User, Perplexity-User, Claude-User)

**Full bot list for the probe:**
| Bot | Operator | Purpose | Honors robots.txt |
|---|---|---|---|
| GPTBot | OpenAI | Training | Yes |
| OAI-SearchBot | OpenAI | Search index | Yes |
| ChatGPT-User | OpenAI | Live fetch | Partial |
| ClaudeBot | Anthropic | Training | Yes |
| Claude-SearchBot | Anthropic | Search index | Yes |
| Claude-User | Anthropic | Live fetch | Partial |
| PerplexityBot | Perplexity | Search index | Yes |
| Perplexity-User | Perplexity | Live fetch | Partial |
| Google-Extended | Google | Training (policy token) | N/A |
| Googlebot | Google | Search index | Yes |
| Bytespider | ByteDance | Training | No (ignores robots.txt) |
| CCBot | Common Crawl | Training aggregator | Yes |
| Meta-ExternalAgent | Meta | Training | Unknown |
| FacebookBot | Meta | Previews | Yes |
| Amazonbot | Amazon | Search/training | Yes |
| Applebot-Extended | Apple | Training (policy token) | N/A |
| CopilotBot | Microsoft | Copilot crawl | Unknown |
| GrokBot | xAI | Training | Unknown |
| MistralAI-User | Mistral | Live fetch | Unknown |
| cohere-ai | Cohere | Training | Unknown |
| YouBot | You.com | Search | Unknown |
| PhindBot | Phind | Search | Unknown |
| DuckAssistBot | DuckDuckGo | Live fetch | Unknown |
| KagiBot | Kagi | Search | Unknown |
| Diffbot | Diffbot | Knowledge graph | Yes |
| ai2bot | AI2 | Research | Unknown |

### 2. Key AEO audit technique: distinguish training vs search vs user-fetch
Blocking a training crawler = opt out of model training.
Blocking a search crawler = remove from AI answers entirely (de-indexing).
Blocking a live-fetch agent = "summarize this link" breaks.
These are DIFFERENT decisions and the audit must distinguish them.

### 3. CDN/WAF blocking is the silent killer
- Cloudflare "Block AI Bots" toggle blocks AI crawlers BEFORE robots.txt is read
- The site owner's robots.txt may say "Allow" but the CDN returns 403
- This is what happened with Napkin — silent CDN block
- Detection method: probe with AI-bot UA vs browser UA, compare status codes
- If AI-bot gets 403/challenge and browser gets 200 → CDN block

### 4. Latest AEO ranking factors (2026 research)
Source: Princeton arXiv 2311.09735, AirOps 2026, Sona 2026

- **Extractability**: First 100 words carry 5x consideration weight
- **Evidence**: Stats (+40% citation lift), citations (+35%), quotes (+30%)
- **Structure**: Sequential H2>H3>H4 = 2.8x citation lift
- **Authority**: Third-party mentions (85% of citations come from off-site)
- **Freshness**: 83% of citations come from pages updated within 12 months

### 5. Schema matters but is oversold
- JSON-LD schema is "foundational hygiene" not a primary citation lever
- The "16-54% lift from schema" claim is misattributed (data.world KG benchmark, not web schema)
- Implement: Article, FAQPage, HowTo, Product, Organization, LocalBusiness

### 6. Measurement gap
- GA4 misses ~99% of AI bot activity (bots don't run JS)
- Server-side bot logging is the only reliable way to see AI crawler activity
- GA4 added "AI Assistant" channel grouping in May 2026 for click-through portion
- Need reverse DNS verification to catch spoofed bots

### 7. New techniques to add to technical-audit
- **Robots.txt managed-section detection**: Cloudflare injects managed blocks — detect them
- **Policy-only tokens**: Google-Extended and Applebot-Extended have no real UA — they're robots.txt directives only
- **Bot verification**: Reverse DNS check against published IP ranges (not just UA matching)
- **CDN fingerprinting**: Detect CDN vendor from response headers (server, cf-ray, via, x-served-by)
- **Multi-probe determinism**: Repeat probes 3x to distinguish deterministic blocks from rate-based ones