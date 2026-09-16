/**
 * Lifecycle policy — G17's definition of what **archive**, **pause**,
 * **delete** and **retain** mean, per resource class, encoded in code rather
 * than described in a document.
 *
 * design_plan G17: "Define what archive/pause/delete means for artifacts,
 * credentials, scheduled work, messages and audit history." The README repeats
 * this table in prose; this file is the version the server actually executes,
 * and the preview endpoint renders it so an operator reads the same sentences
 * the executor will act on.
 *
 * Three rules are structural here, not stylistic:
 *
 * 1. **`archive` is only assigned where the row genuinely has a non-destructive
 *    terminal state.** A table with no archive column is never described as
 *    archived — it is `retain`ed or `delete`d, because a policy that claims to
 *    archive rows it cannot mark would be a lie the preview then repeats.
 *
 * 2. **Credentials default to `delete`.** Offboarding a client has exactly one
 *    non-negotiable effect: their access ends. Everything else is a judgement
 *    call an operator can override; this is not.
 *
 * 3. **Audit history is not deletable by offboarding.** `activity-events`
 *    carries `overridable: false`, and `OffboardingService` refuses a supplied
 *    override for it rather than quietly ignoring it — the audit trail is what
 *    makes the rest of the offboarding checkable afterwards.
 *
 * @module lifecycle.policy
 */

/** What an offboarding can do to a set of rows. */
export type LifecycleAction = 'archive' | 'pause' | 'delete' | 'retain';

/** The five classes design_plan G17 names. */
export type ResourceClass = 'artifact' | 'credential' | 'scheduled-work' | 'message' | 'audit-history';

export const RESOURCE_CLASSES: readonly ResourceClass[] = [
  'artifact',
  'credential',
  'scheduled-work',
  'message',
  'audit-history',
];

/** The class-level definition, independent of which rows it covers. */
export interface ClassMeaning {
  label: string;
  meaning: string;
}

/**
 * What each action means, in the words the preview and the README both use.
 *
 * These are the sentences an operator confirms against. They describe the
 * *class* of effect; {@link RESOURCE_POLICIES} gives the per-resource
 * consequence.
 */
export const ACTION_MEANINGS: Record<LifecycleAction, ClassMeaning> = {
  archive: {
    label: 'Archive',
    meaning:
      'The rows stay, and are marked so they are no longer active: the project leaves the active portfolio, the report is withdrawn, the brief is archived. Nothing is destroyed and the record remains queryable, so a historical report still renders.',
  },
  pause: {
    label: 'Pause',
    meaning:
      'Recurring work stops being scheduled. The configuration is kept, so the schedule can be resumed if the client returns. Nothing is deleted and no in-flight run is modified.',
  },
  delete: {
    label: 'Delete',
    meaning:
      'The rows are removed from their tables. Where a row has a soft-delete column, the delete is applied through it; otherwise the row is removed. The audit record of this offboarding is written before the rows go and is retained under policy.',
  },
  retain: {
    label: 'Retain',
    meaning:
      'Offboarding leaves these rows untouched. They are listed in the preview so their survival is a decision the operator can see, not an omission they have to notice.',
  },
};

/** One resource type's policy. */
export interface ResourcePolicy {
  /** Machine key, used in `planned`/`executed` and in `overrides`. */
  resourceType: string;
  label: string;
  resourceClass: ResourceClass;
  /** What the default offboarding does. */
  action: LifecycleAction;
  /** One sentence saying what this action does to these rows specifically. */
  meaning: string;
  /** What is lost or stopped, stated plainly for the confirmation screen. */
  consequence: string;
  /**
   * Whether an execute may choose a different action. False means the policy
   * is fixed and a supplied override is refused (not ignored).
   */
  overridable: boolean;
  /** The actions an override may select. Always includes `action`. */
  allowedActions: readonly LifecycleAction[];
}

/**
 * The policy table.
 *
 * Order matters only for readability; the preview sorts by class.
 */
export const RESOURCE_POLICIES: readonly ResourcePolicy[] = [
  // ── Artifacts ─────────────────────────────────────────────────────
  {
    resourceType: 'client',
    label: 'Client record',
    resourceClass: 'artifact',
    action: 'archive',
    meaning: 'Client.status is set to `churned`. The row and its commercial history stay.',
    consequence: 'The client leaves the active book of business. Nothing is deleted.',
    overridable: true,
    allowedActions: ['archive', 'retain'],
  },
  {
    resourceType: 'projects',
    label: 'Projects',
    resourceClass: 'artifact',
    action: 'archive',
    meaning: 'Project.status is set to `archived`. The project leaves the active portfolio.',
    consequence: 'The project stops appearing as active and stops being scheduled. Its reports and evidence stay.',
    overridable: true,
    allowedActions: ['archive', 'delete'],
  },
  {
    resourceType: 'reports',
    label: 'Reports',
    resourceClass: 'artifact',
    action: 'archive',
    meaning: 'Report.status is set to `withdrawn`. `visibility` is left alone here — it is governed by `shareLinkPolicy`.',
    consequence: 'Reports stop being treated as current. Whether their public links keep working is decided separately by the share-link policy.',
    overridable: true,
    allowedActions: ['archive', 'delete'],
  },
  {
    resourceType: 'report-revisions',
    label: 'Report revisions',
    resourceClass: 'artifact',
    action: 'retain',
    meaning: 'Frozen revision snapshots are left in place. They are the report\'s history and have no archive state of their own.',
    consequence: 'Revisions survive. They are reachable only through their report.',
    overridable: true,
    allowedActions: ['retain', 'delete'],
  },
  {
    resourceType: 'report-delivery-attempts',
    label: 'Report delivery attempts',
    resourceClass: 'message',
    action: 'retain',
    meaning: 'The send log is kept. It holds a recipient address per attempt and is the evidence a report was delivered.',
    consequence: 'Recipient addresses survive offboarding unless this resource type is explicitly overridden to `delete`.',
    overridable: true,
    allowedActions: ['retain', 'delete'],
  },
  {
    resourceType: 'content-briefs',
    label: 'Content briefs',
    resourceClass: 'artifact',
    action: 'archive',
    meaning: 'ContentBrief.status is set to `archived`.',
    consequence: 'Briefs stop being usable for new generation. Their text stays.',
    overridable: true,
    allowedActions: ['archive', 'delete'],
  },
  {
    resourceType: 'content-revisions',
    label: 'Content revisions',
    resourceClass: 'artifact',
    action: 'retain',
    meaning: 'Revision history is left in place; it has no archive state of its own.',
    consequence: 'Revisions survive; they are reachable only through their brief.',
    overridable: true,
    allowedActions: ['retain', 'delete'],
  },
  {
    resourceType: 'work-items',
    label: 'Work items',
    resourceClass: 'artifact',
    action: 'archive',
    meaning: 'WorkItem.status is set to `cancelled` for every item that is not already terminal.',
    consequence: 'Open work stops counting as committed or in flight. The items and their history stay readable.',
    overridable: true,
    allowedActions: ['archive', 'retain', 'delete'],
  },
  {
    resourceType: 'cycles',
    label: 'Delivery cycles',
    resourceClass: 'artifact',
    action: 'archive',
    meaning: 'Cycle.status is set to `closed` for every cycle that is not already closed.',
    consequence: 'Time-boxed commitments close out. Their committed counts stay frozen and readable.',
    overridable: true,
    allowedActions: ['archive', 'retain', 'delete'],
  },
  {
    resourceType: 'milestones',
    label: 'Milestones',
    resourceClass: 'artifact',
    action: 'retain',
    meaning: 'Milestones have no archive state, so they are listed and kept.',
    consequence: 'Milestones survive offboarding unless explicitly overridden to `delete`.',
    overridable: true,
    allowedActions: ['retain', 'delete'],
  },
  {
    resourceType: 'attachments',
    label: 'Attachments',
    resourceClass: 'artifact',
    action: 'delete',
    meaning: 'Attachment.deletedAt is stamped. The row and its storage key are kept so the deletion itself is auditable.',
    consequence: 'Uploaded files stop being reachable. They are already excluded from every read that filters `deletedAt`.',
    overridable: true,
    allowedActions: ['delete', 'retain'],
  },
  {
    resourceType: 'observations',
    label: 'Measurement observations',
    resourceClass: 'artifact',
    action: 'delete',
    meaning: 'AI answers, their citations and their model metadata are removed.',
    consequence:
      'The client\'s measured AI answers — including verbatim model output that may quote third parties — stop existing on this system. Reports already released stay readable, but an evidence manifest pinned to these rows would no longer resolve; the preview names any such manifest.',
    overridable: true,
    allowedActions: ['delete', 'retain'],
  },
  {
    resourceType: 'measurement-runs',
    label: 'Measurement runs',
    resourceClass: 'artifact',
    action: 'delete',
    meaning: 'Run records, their cost figures and their status history are removed.',
    consequence: 'Run-level coverage and cost history is lost. Deleted after observations, which reference them.',
    overridable: true,
    allowedActions: ['delete', 'retain'],
  },
  {
    resourceType: 'score-runs',
    label: 'Rubric score runs',
    resourceClass: 'artifact',
    action: 'delete',
    meaning: 'Historically computed rubric totals and their sub-scores are removed.',
    consequence: 'Past scores stop being retrievable. Released reports keep the figure they were frozen with.',
    overridable: true,
    allowedActions: ['delete', 'retain'],
  },
  {
    resourceType: 'technical-audits',
    label: 'Technical audits',
    resourceClass: 'artifact',
    action: 'retain',
    meaning: 'Crawl results and findings are kept. Their module has no archive state and they are the evidence behind shipped fixes.',
    consequence: 'Audit history survives offboarding unless explicitly overridden to `delete`.',
    overridable: true,
    allowedActions: ['retain', 'delete'],
  },
  {
    resourceType: 'seo-audits',
    label: 'Search Console audits',
    resourceClass: 'artifact',
    action: 'delete',
    meaning: 'Search-performance rows imported under this client\'s Google grant are removed.',
    consequence: 'Imported click, impression and position history is lost. The Google grant itself is revoked separately under credentials.',
    overridable: true,
    allowedActions: ['delete', 'retain'],
  },
  {
    resourceType: 'aeo-audits',
    label: 'AEO audits and stance judgments',
    resourceClass: 'artifact',
    action: 'delete',
    meaning: 'AEO audit rows, per-surface runs and LLM stance judgments are removed, along with the observations they produced.',
    consequence: 'Model judgments about brands named in answers stop existing on this system.',
    overridable: true,
    allowedActions: ['delete', 'retain'],
  },
  {
    resourceType: 'presence-discoveries',
    label: 'Presence discoveries',
    resourceClass: 'artifact',
    action: 'retain',
    meaning: 'Account-discovery runs are kept; they record what was found and what was left unverified.',
    consequence: 'Presence history survives unless explicitly overridden to `delete`.',
    overridable: true,
    allowedActions: ['retain', 'delete'],
  },
  {
    resourceType: 'authority-scans',
    label: 'Authority scans',
    resourceClass: 'artifact',
    action: 'retain',
    meaning: 'Authority scans and their candidates are kept; they are third-party list evidence rather than client data.',
    consequence: 'Authority history survives unless explicitly overridden to `delete`.',
    overridable: true,
    allowedActions: ['retain', 'delete'],
  },
  {
    resourceType: 'backlinks-summaries',
    label: 'Backlinks snapshots',
    resourceClass: 'artifact',
    action: 'retain',
    meaning: 'Provider snapshots are kept; they are third-party link data.',
    consequence: 'Backlink snapshots survive unless explicitly overridden to `delete`.',
    overridable: true,
    allowedActions: ['retain', 'delete'],
  },
  {
    resourceType: 'competitors',
    label: 'Tracked competitors',
    resourceClass: 'artifact',
    action: 'retain',
    meaning: 'The tracked competitor set is kept. It is public, not the client\'s data.',
    consequence: 'Competitor tracking survives; it is scoped to projects that are themselves archived.',
    overridable: true,
    allowedActions: ['retain', 'delete'],
  },
  {
    resourceType: 'query-sets',
    label: 'Query sets and prompts',
    resourceClass: 'artifact',
    action: 'retain',
    meaning: 'Query sets are kept. They define the methodology the client\'s history was measured under.',
    consequence: 'Prompt history survives unless explicitly overridden to `delete`.',
    overridable: true,
    allowedActions: ['retain', 'delete'],
  },
  {
    resourceType: 'personas',
    label: 'Research personas and journeys',
    resourceClass: 'artifact',
    action: 'retain',
    meaning: 'Research personas and their journeys are kept; they are derived research identities, not client content.',
    consequence: 'Personas survive unless explicitly overridden to `delete`.',
    overridable: true,
    allowedActions: ['retain', 'delete'],
  },

  // ── Credentials ───────────────────────────────────────────────────
  {
    resourceType: 'google-connections',
    label: 'Google connections',
    resourceClass: 'credential',
    action: 'delete',
    meaning: 'The stored OAuth grant is removed. This is the row that makes Google data reachable.',
    consequence: 'Cailyx loses access to this client\'s Google properties. This is not overridable to `retain` through an offboarding — revoke it deliberately through the Google connection endpoint if the client is staying.',
    overridable: false,
    allowedActions: ['delete'],
  },
  {
    resourceType: 'connection-delegations',
    label: 'Client-access delegations',
    resourceClass: 'credential',
    action: 'delete',
    meaning: 'Delegated-access grants are removed, ending any scope where Cailyx acted through the client\'s own account.',
    consequence: 'Delegated access ends immediately.',
    overridable: false,
    allowedActions: ['delete'],
  },
  {
    resourceType: 'client-members',
    label: 'Portal seats',
    resourceClass: 'credential',
    action: 'delete',
    meaning: 'ClientMember rows are removed, so no seat remains attached to this client.',
    consequence: 'Portal seats stop existing.',
    overridable: false,
    allowedActions: ['delete'],
  },
  {
    resourceType: 'client-users',
    label: 'Client user logins',
    resourceClass: 'credential',
    action: 'delete',
    meaning: 'User rows of type `client` belonging to this client are removed, together with their refresh tokens, sessions and one-time auth tokens.',
    consequence: 'Those logins stop working everywhere, including any session already open. Their audit trail stays.',
    overridable: false,
    allowedActions: ['delete'],
  },
  {
    resourceType: 'auth-tokens',
    label: 'Outstanding one-time tokens',
    resourceClass: 'credential',
    action: 'delete',
    meaning: 'Unspent login and invite tokens for this client\'s users are removed.',
    consequence: 'Any pending invite or magic link stops working.',
    overridable: false,
    allowedActions: ['delete'],
  },

  // ── Scheduled work ────────────────────────────────────────────────
  {
    resourceType: 'cadence-rules',
    label: 'Cadence rules',
    resourceClass: 'scheduled-work',
    action: 'pause',
    meaning: 'CadenceRule.pausedAt is stamped and `enabled` set to false. The schedule itself is kept.',
    consequence: 'Recurring audits stop firing. No new provider cost is incurred for this client.',
    overridable: false,
    allowedActions: ['pause'],
  },
  {
    resourceType: 'schedule-configs',
    label: 'Project schedules',
    resourceClass: 'scheduled-work',
    action: 'pause',
    meaning: 'ScheduleConfig.active and `seoActive` are set to false. The cadence configuration is kept.',
    consequence: 'Both the technical-audit and the Search Console schedules stop.',
    overridable: false,
    allowedActions: ['pause'],
  },
  {
    resourceType: 'engagements',
    label: 'Engagements',
    resourceClass: 'scheduled-work',
    action: 'pause',
    meaning: 'Engagement.status is set to `paused` and `pausedAt` stamped, which stops cadence ticks that resolve through it.',
    consequence: 'The commercial commitment stops accruing. Contracted hours are kept for the record.',
    overridable: true,
    allowedActions: ['pause', 'archive'],
  },

  // ── Messages ──────────────────────────────────────────────────────
  {
    resourceType: 'client-messages',
    label: 'Client messages',
    resourceClass: 'message',
    action: 'retain',
    meaning: 'The thread is kept. ClientMessage has no archive state, so `archive` is not offered for it.',
    consequence:
      'The record of what was discussed and agreed survives offboarding unless this resource type is explicitly overridden to `delete`. Export the thread before executing if the client wants a copy.',
    overridable: true,
    allowedActions: ['retain', 'delete'],
  },
  {
    resourceType: 'message-read-cursors',
    label: 'Read cursors',
    resourceClass: 'message',
    action: 'delete',
    meaning: 'Per-user read positions are removed with the client\'s users; they have no meaning without a reader.',
    consequence: 'Nothing a person would notice; unread counts are per-user state.',
    overridable: false,
    allowedActions: ['delete'],
  },

  // ── Audit history ─────────────────────────────────────────────────
  {
    resourceType: 'activity-events',
    label: 'Audit trail',
    resourceClass: 'audit-history',
    action: 'retain',
    meaning:
      'ActivityEvent rows are append-only and are never deleted by offboarding. The offboarding itself writes to this table before it removes anything.',
    consequence:
      'The record of what was done, by whom and when survives the deletion of the resources it describes. This is deliberate and is not overridable.',
    overridable: false,
    allowedActions: ['retain'],
  },
  {
    resourceType: 'job-runs',
    label: 'Background job ledger',
    resourceClass: 'audit-history',
    action: 'retain',
    meaning: 'The durable run ledger is kept so past work and its cost stay accountable after the client leaves.',
    consequence: 'Job history survives unless explicitly overridden to `delete`. Deleting it removes the record that scheduled work ever ran.',
    overridable: true,
    allowedActions: ['retain', 'delete'],
  },
  {
    resourceType: 'verifications',
    label: 'Verification records',
    resourceClass: 'audit-history',
    action: 'retain',
    meaning: 'Reviewer observations of delivered work are kept: they are the evidence a deliverable was actually verified.',
    consequence: 'Verification history survives unless explicitly overridden to `delete`.',
    overridable: true,
    allowedActions: ['retain', 'delete'],
  },
  {
    resourceType: 'approvals',
    label: 'Approval decisions',
    resourceClass: 'audit-history',
    action: 'retain',
    meaning: 'Approval requests and their decisions are kept; a decision is immutable and superseding it is a new row, not an edit.',
    consequence: 'Approval history survives unless explicitly overridden to `delete`.',
    overridable: true,
    allowedActions: ['retain', 'delete'],
  },
  {
    resourceType: 'exports',
    label: 'Export request history',
    resourceClass: 'audit-history',
    action: 'retain',
    meaning: 'The record that an export was requested and downloaded is kept; the export file itself expires on its own schedule.',
    consequence: 'Export history survives. The generated files are removed when their `expiresAt` passes, independently of this policy.',
    overridable: true,
    allowedActions: ['retain', 'delete'],
  },
];

/** The policy for one resource type. */
export function policyFor(resourceType: string): ResourcePolicy | undefined {
  return RESOURCE_POLICIES.find((policy) => policy.resourceType === resourceType);
}

/**
 * The resource types in the order an execute must process them.
 *
 * Ordering is a real constraint, not presentation: observations reference their
 * measurement run, revisions reference their report, and a project delete would
 * otherwise orphan rows that a later step still needs to count. Children before
 * parents, always.
 */
export const EXECUTION_ORDER: readonly string[] = [
  // Leaf records first.
  'observations',
  'aeo-audits',
  'measurement-runs',
  'score-runs',
  'seo-audits',
  'technical-audits',
  'presence-discoveries',
  'authority-scans',
  'backlinks-summaries',
  'content-revisions',
  'content-briefs',
  'report-delivery-attempts',
  'report-revisions',
  'reports',
  'message-read-cursors',
  'client-messages',
  'verifications',
  'work-items',
  'cycles',
  'milestones',
  'attachments',
  'personas',
  'query-sets',
  'competitors',
  'engagements',
  'cadence-rules',
  'schedule-configs',
  // The ledger survives the resources it describes, so it is never in a
  // position where removing it would strand a later step's audit record.
  'job-runs',
  'approvals',
  'exports',
  'activity-events',
  // Parents last.
  'projects',
  'client-members',
  'auth-tokens',
  'client-users',
  'connection-delegations',
  'google-connections',
  'client',
];

/** Sort resource types into execution order; anything unlisted goes last, alphabetically. */
export function inExecutionOrder(resourceTypes: string[]): string[] {
  const rank = new Map(EXECUTION_ORDER.map((type, index) => [type, index]));
  return [...resourceTypes].sort((a, b) => {
    const ra = rank.get(a) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ra === rb ? a.localeCompare(b) : ra - rb;
  });
}
