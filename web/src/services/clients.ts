import { api, unwrap } from '@/lib/api';
import type { ClientDetail, ClientStatus, ClientSummary, ProjectSummary } from './types';

/**
 * Client management adapter (Appendix C.2).
 *
 * Every function normalizes the response envelope explicitly. design_plan §10.2
 * warns that the API mixes `{clients: [...]}` wrappers with bare arrays, and
 * that reading an unexpected shape as "no data" is how a failed request turns
 * into a convincing empty screen.
 */

export async function listClients(options?: { signal?: AbortSignal }): Promise<ClientSummary[]> {
  const payload = await api.get<{ clients: ClientSummary[] }>('/clients', options);
  return unwrap<ClientSummary[]>(payload, 'clients');
}

export async function getClient(
  clientId: string,
  options?: { signal?: AbortSignal },
): Promise<ClientDetail> {
  // Returned unwrapped, unlike the list above.
  return api.get<ClientDetail>(`/clients/${clientId}`, options);
}

export interface CreateClientInput {
  name: string;
  contactName?: string;
  contactEmail?: string;
  ownerUserId?: string;
  notes?: string;
}

export async function createClient(input: CreateClientInput) {
  return api.post<{ id: string; name: string; status: ClientStatus; createdAt: string }>(
    '/clients',
    input,
  );
}

export interface UpdateClientInput {
  name?: string;
  contactName?: string | null;
  contactEmail?: string | null;
  status?: ClientStatus;
  ownerUserId?: string | null;
  notes?: string | null;
}

export async function updateClient(clientId: string, input: UpdateClientInput) {
  return api.patch<{ id: string; name: string; status: ClientStatus }>(
    `/clients/${clientId}`,
    input,
  );
}

/**
 * Issues a client-portal login and returns a **one-time** password for handoff.
 *
 * `emailSent` is reported separately and on purpose: design_plan §11.2 case 2
 * requires the UI to keep showing "account created" when the email fails, and
 * never to retry account creation as a way of retrying the email.
 */
export async function createClientLogin(
  clientId: string,
  input: { email: string; name: string },
) {
  return api.post<{
    userId: string;
    email: string;
    temporaryPassword: string;
    emailSent: boolean;
    emailError?: string | null;
  }>(`/clients/${clientId}/login`, input);
}

/**
 * The four optional research stages of the day-1 pipeline.
 *
 * Each one spends real provider credits, so each is opt-in and off by default
 * — and the screen has to say so next to the switch (§10.4 "scan/generation":
 * scope and cost before an explicit start). They are `boolean` flags rather
 * than a mode string because the backend takes them independently: a caller
 * may want the AEO audit without the backlink pull.
 *
 * The field names are the DTO's exact names. The API runs
 * `forbidNonWhitelisted: true`, so an extra or renamed key is a 400 rather
 * than an ignored field — `category` and `runPipeline` were both wrong here.
 */
export interface CreateClientProjectInput {
  name: string;
  /** Bare domain, e.g. "example.com". The server rejects a duplicate with 409. */
  domain: string;
  /** Opt-in: full AEO (answer-engine) audit. Costs Cloro/LLM credits per run. */
  runAeoAudit?: boolean;
  /** Opt-in: keyword research seeded from the enrichment category. Costs DataForSEO credits. */
  runKeywordResearch?: boolean;
  /** Opt-in: growth-execution asset briefs from the strategy output. */
  runGrowthExecution?: boolean;
  /** Opt-in: a fresh backlinks profile. Costs DataForSEO credits. */
  runBacklinksRefresh?: boolean;
}

/**
 * Creates a project under a client and starts the day-1 pipeline.
 *
 * Returns immediately with `onboardingStatus: "running"` — the pipeline runs
 * server-side for a minute or more whether or not this page is still open, so
 * the returned project id must be persisted before navigating (§10.3).
 *
 * **A domain that already exists is a 409** (`ApiError.kind === 'conflict'`),
 * not something this adapter pre-checks. §4.2 specifies "duplicate check via
 * submit" precisely so the answer comes from the same unique constraint that
 * will actually reject the insert; a client-side check would race with another
 * operator and could disagree with the database.
 */
export async function createClientProject(
  clientId: string,
  input: CreateClientProjectInput,
) {
  return api.post<ProjectSummary>(`/clients/${clientId}/projects`, input);
}
