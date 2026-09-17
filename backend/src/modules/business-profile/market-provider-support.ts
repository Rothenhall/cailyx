/**
 * Market provider-support preview — plan §10.3's adapter contract, computed
 * statically from what each adapter's request-building code was actually
 * read to do (not from a wish-list). No network call is made here; this is a
 * preview of what a provider call WOULD claim, given the adapter code as it
 * exists today.
 *
 * Findings, each traced to the file read to establish it:
 *
 * - `backend/src/modules/measurement/adapters/cloro.adapter.ts` —
 *   `CloroAdapterBase.buildPayload(prompt, geo)` sends `{ prompt, country: geo }`
 *   (or `{ query, country, include }` for AI Overview) to every Cloro surface.
 *   There is no city/region field anywhere in the payload. That is a real
 *   country-level provider request (`provider-targeted`, `country`
 *   granularity) — and proof of nothing finer. A target asking for city
 *   granularity on a Cloro surface is `unsupported`, not silently served at
 *   country scope and labelled as the city.
 * - `backend/src/modules/serp-intelligence/dataforseo-serp.service.ts` —
 *   `search()` forwards `opts.locationName` verbatim as DataForSEO's
 *   `location_name`, with no validation against DataForSEO's published
 *   location list (plan §10.3: "SERP locationName support ... needs
 *   validated provider location mappings, not arbitrary text accepted by a
 *   form"). DataForSEO's API genuinely supports city-level `location_name`
 *   values, but this codebase does not validate them today, so only a small
 *   whitelist of known-good country/city names below is reported
 *   `provider-targeted`; anything else is `unsupported` with that reason
 *   stated, rather than assumed to work.
 * - `backend/src/modules/measurement/adapters/anthropic.adapter.ts` — the
 *   `geo` parameter is received and explicitly discarded
 *   (`void geometry; // geo steering per run arrives with proxy egress`).
 *   Nothing in the request reflects the requested location. `unsupported`.
 * - `backend/src/modules/measurement/adapters/perplexity.adapter.ts` — `geo`
 *   is logged for the observation record but never placed in the request body
 *   or the prompt text sent to the Perplexity API. `unsupported` — not even
 *   `prompt-localized`, because the location word never reaches the prompt.
 * - `backend/src/modules/measurement/adapters/browser-surface.adapter.ts` —
 *   the adapter's own doc comment: "`@param geo` Recorded on the observation.
 *   Not steered — that needs proxy egress, and faking it would be worse than
 *   saying so." Same as above: `unsupported`.
 *
 * §10.3: "A prompt mentioning 'New York' is not proof the response was
 * observed as a New York user." None of the adapters read here insert the
 * location into the prompt text at all, so `prompt-localized` is not used by
 * any entry below — it is kept in the type for a future adapter that
 * genuinely does that (and would still need excluding from
 * geo-targeted comparisons per §10.3).
 *
 * @module market-provider-support
 */

import type { LocationGranularity, MarketTarget, ProviderTargetSupport, ProviderTargetingMode } from './business-profile.types';

interface ProviderCapability {
  provider: string;
  providerLabel: string;
  /** Countries this provider can genuinely claim country-level targeting for. `'*'` = any 2-letter code, since Cloro accepts any ISO country and the DB doesn't reject unknown ones — the mapping is 1:1, no validated allow-list needed at country grain. */
  countryMode: ProviderTargetingMode;
  countryMapping: (country: string) => string;
  /** Whitelisted `${country}:${city.toLowerCase()}` keys this provider is known to genuinely support at city grain, mapped to the exact provider location string. Empty = never claims city grain. */
  cityWhitelist: Record<string, string>;
}

/** DataForSEO `location_name` values verified against DataForSEO's published Google Ads location list format ("City,Region,Country"). Deliberately tiny — anything not here is reported unsupported rather than guessed. */
const DATAFORSEO_CITY_WHITELIST: Record<string, string> = {
  'us:new york': 'New York,New York,United States',
  'us:los angeles': 'Los Angeles,California,United States',
  'us:chicago': 'Chicago,Illinois,United States',
  'gb:london': 'London,England,United Kingdom',
  'in:mumbai': 'Mumbai,Maharashtra,India',
  'in:bengaluru': 'Bangalore,Karnataka,India',
  'au:sydney': 'Sydney,New South Wales,Australia',
};

const DATAFORSEO_COUNTRY_NAMES: Record<string, string> = {
  US: 'United States', GB: 'United Kingdom', CA: 'Canada', AU: 'Australia', NZ: 'New Zealand',
  IN: 'India', IE: 'Ireland', DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy',
  NL: 'Netherlands', SE: 'Sweden', SG: 'Singapore', AE: 'United Arab Emirates', BR: 'Brazil',
  MX: 'Mexico', ZA: 'South Africa', JP: 'Japan',
};

const CLORO_PROVIDERS: ReadonlyArray<{ provider: string; providerLabel: string }> = [
  { provider: 'cloro-chatgpt', providerLabel: 'ChatGPT (via Cloro)' },
  { provider: 'cloro-perplexity', providerLabel: 'Perplexity (via Cloro)' },
  { provider: 'cloro-gemini', providerLabel: 'Gemini (via Cloro)' },
  { provider: 'cloro-ai-overview', providerLabel: 'Google AI Overview (via Cloro)' },
  { provider: 'cloro-ai-mode', providerLabel: 'Google AI Mode (via Cloro)' },
];

const CAPABILITIES: ProviderCapability[] = [
  ...CLORO_PROVIDERS.map((p) => ({
    ...p,
    countryMode: 'provider-targeted' as const,
    countryMapping: (country: string) => `payload.country = "${country}"`,
    cityWhitelist: {},
  })),
  {
    provider: 'dataforseo-serp',
    providerLabel: 'Google SERP (DataForSEO)',
    countryMode: 'provider-targeted',
    countryMapping: (country: string) =>
      DATAFORSEO_COUNTRY_NAMES[country] ? `location_name = "${DATAFORSEO_COUNTRY_NAMES[country]}"` : `location_name = "${country}" (not a validated DataForSEO country name)`,
    cityWhitelist: DATAFORSEO_CITY_WHITELIST,
  },
  {
    provider: 'claude',
    providerLabel: 'Claude (Anthropic API)',
    countryMode: 'unsupported',
    countryMapping: () => 'geo argument received and explicitly discarded (proxy egress not wired up)',
    cityWhitelist: {},
  },
  {
    provider: 'perplexity',
    providerLabel: 'Perplexity (Sonar API)',
    countryMode: 'unsupported',
    countryMapping: () => 'geo recorded on the observation only — never sent in the request or prompt',
    cityWhitelist: {},
  },
  {
    provider: 'chatgpt-browser',
    providerLabel: 'ChatGPT (browser session)',
    countryMode: 'unsupported',
    countryMapping: () => 'geo recorded on the observation only — session is not proxied to the requested region',
    cityWhitelist: {},
  },
  {
    provider: 'perplexity-browser',
    providerLabel: 'Perplexity (browser session)',
    countryMode: 'unsupported',
    countryMapping: () => 'geo recorded on the observation only — session is not proxied to the requested region',
    cityWhitelist: {},
  },
  {
    provider: 'gemini-browser',
    providerLabel: 'Gemini (browser session)',
    countryMode: 'unsupported',
    countryMapping: () => 'geo recorded on the observation only — session is not proxied to the requested region',
    cityWhitelist: {},
  },
];

function supportForOne(cap: ProviderCapability, target: MarketTarget): ProviderTargetSupport {
  const country = target.country.toUpperCase();
  const wantsCity = target.city !== null && target.city.trim().length > 0;

  if (wantsCity) {
    const key = `${country.toLowerCase()}:${target.city!.trim().toLowerCase()}`;
    const mapped = cap.cityWhitelist[key];
    if (mapped) {
      return {
        provider: cap.provider,
        providerLabel: cap.providerLabel,
        requestedCountry: country,
        requestedCity: target.city,
        effectiveGranularity: 'city',
        mode: 'provider-targeted',
        providerMapping: mapped,
        supported: true,
        detail: `${cap.providerLabel} can genuinely target ${target.city}, ${country} — validated location mapping on file.`,
      };
    }
    // City requested but not provable at city grain on this provider. Never
    // silently widen to country and call it the city (§10.2 step 6 / §10.3).
    return {
      provider: cap.provider,
      providerLabel: cap.providerLabel,
      requestedCountry: country,
      requestedCity: target.city,
      effectiveGranularity: 'none',
      mode: 'unsupported',
      providerMapping: null,
      supported: false,
      detail:
        `${cap.providerLabel} has no validated way to target ${target.city}, ${country} specifically. ` +
        `${cap.countryMode === 'provider-targeted' ? 'It can target the country as a whole — an explicit fallback to country scope, not a silent one.' : 'It cannot target location at all.'}`,
    };
  }

  if (cap.countryMode === 'provider-targeted') {
    return {
      provider: cap.provider,
      providerLabel: cap.providerLabel,
      requestedCountry: country,
      requestedCity: null,
      effectiveGranularity: 'country',
      mode: 'provider-targeted',
      providerMapping: cap.countryMapping(country),
      supported: true,
      detail: `${cap.providerLabel} accepts a real country-level targeting parameter (${cap.countryMapping(country)}).`,
    };
  }

  return {
    provider: cap.provider,
    providerLabel: cap.providerLabel,
    requestedCountry: country,
    requestedCity: null,
    effectiveGranularity: 'none',
    mode: 'unsupported',
    providerMapping: null,
    supported: false,
    detail: `${cap.providerLabel} does not target location at all today: ${cap.countryMapping(country)}.`,
  };
}

/** Every known provider's real support for every given (active) target. Read-only preview; makes no network call. */
export function previewProviderSupport(targets: MarketTarget[]): ProviderTargetSupport[] {
  const active = targets.filter((t) => t.active);
  const out: ProviderTargetSupport[] = [];
  for (const target of active) {
    for (const cap of CAPABILITIES) {
      out.push(supportForOne(cap, target));
    }
  }
  return out;
}
