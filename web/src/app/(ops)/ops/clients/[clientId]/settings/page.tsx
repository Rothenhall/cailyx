'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatTimestamp } from '@/lib/format';
import { clientStatusLabel, clientStatusTone } from '@/lib/status-tones';
import { getClient, updateClient, type UpdateClientInput } from '@/services/clients';
import { listTeamMembers, OPERATOR_ROLE_LABEL, type TeamMember } from '@/services/delivery-plan';
import type { ClientDetail, ClientStatus, ProjectSummary } from '@/services/types';
import { ApiError } from '@/lib/api';

/**
 * OP05 — Client settings.
 *
 * design_plan.md §4.2: *"Edit contact/status/owner/notes; pause/churn
 * explanation"*, with support "Core E; enforce downstream pause policy
 * G06/G07".
 *
 * Three rules shape this screen:
 *
 * 1. **A pause or a churn is explained, not just selected.** §7.6's pause
 *    policy says a paused client stops future paid recurrence and
 *    publications, while retained work stays exactly where it is. So the
 *    consequence is stated *before* the change, the reason is required, and
 *    the projects that stay in flight are named.
 *
 * 2. **The explanation has nowhere of its own to go.** `PATCH /clients/:id`
 *    accepts `status` with no reason field, and the model has no
 *    `pauseReason` (unlike `Engagement`, which does — G06). Rather than show a
 *    reason box that quietly discards what was typed, the text is appended to
 *    the internal notes with a visible marker, and the screen says so. Nothing
 *    is written anywhere the operator was not told about.
 *
 * 3. **The owner directory is admin-only.** `GET /users` is `@Roles('admin')`
 *    at the class level and G03 records that a non-admin directory does not
 *    exist. A non-admin gets an explicit "enter the operator id" field with
 *    the reason stated, never a silently empty picker that looks like "there
 *    are no operators".
 */
export default function ClientSettingsPage() {
  const params = useParams<{ clientId: string }>();
  const clientId = params.clientId;
  const router = useRouter();

  const [client, setClient] = useState<ClientDetail | null>(null);
  const [loadError, setLoadError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [loading, setLoading] = useState(true);

  /** Admin-only. `null` means "not loaded"; `forbidden` is its own state. */
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [membersForbidden, setMembersForbidden] = useState(false);

  const [name, setName] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [status, setStatus] = useState<ClientStatus>('active');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]> | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setLoadError(null);
        setLoading(true);
        const detail = await getClient(clientId, { signal });
        setClient(detail);
        setName(detail.name);
        setContactName(detail.contactName ?? '');
        setContactEmail(detail.contactEmail ?? '');
        setStatus(detail.status);
        setOwnerUserId(detail.ownerUserId ?? '');
        setNotes(detail.notes ?? '');
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setLoadError(toApiError(caught));
      } finally {
        setLoading(false);
      }
    },
    [clientId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // The directory is a separate, optional read: a 403 must not take the form
  // down with it, because the operator can still edit everything else.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const rows = await listTeamMembers({ signal: controller.signal });
        setMembers(rows.filter((m) => m.type !== 'client'));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        if (caught instanceof ApiError && caught.kind === 'forbidden') {
          setMembersForbidden(true);
          return;
        }
        // Any other failure leaves the id field as free text; the form still works.
        setMembers([]);
      }
    })();
    return () => controller.abort();
  }, []);

  const currentStatus = client?.status ?? 'active';
  const statusChanging = status !== currentStatus;
  /** Pause and churn both stop future scheduled work, so both need a reason. */
  const needsReason = statusChanging && (status === 'paused' || status === 'churned');
  const inFlightProjects = (client?.projects ?? []).filter((p) => p.status !== 'archived');

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;

    setFormError(null);
    setFieldErrors(null);

    if (!name.trim()) {
      setFieldErrors({ name: ['Client name is required.'] });
      setFormError('Enter the client name before saving.');
      focusField('name');
      return;
    }
    if (needsReason && !reason.trim()) {
      setFieldErrors({ reason: ['Explain why this client is being paused or churned.'] });
      setFormError('Explain the pause or churn before saving.');
      focusField('reason');
      return;
    }

    // The reason is folded into the notes deliberately, and only for the
    // change that was actually made — a save that leaves the status alone
    // never touches this.
    const appendedNotes =
      needsReason && reason.trim()
        ? appendReason(notes, status, reason.trim())
        : notes;

    const input: UpdateClientInput = {
      name: name.trim(),
      contactName: contactName.trim() || null,
      contactEmail: contactEmail.trim() || null,
      status,
      ownerUserId: ownerUserId.trim() || null,
      notes: appendedNotes.trim() || null,
    };

    setSaving(true);
    try {
      await updateClient(clientId, input);
      setNotes(appendedNotes);
      setReason('');
      setSavedAt(new Date().toISOString());
      await load();
    } catch (caught) {
      const error = toApiError(caught);
      setFieldErrors(error.fieldErrors ?? null);
      setFormError(
        error.kind === 'conflict'
          ? 'The client record changed on the server since this page loaded. Reload and re-apply your change.'
          : 'Your change was not saved. Nothing on the server was modified.',
      );
      if (error.fieldErrors) focusField(Object.keys(error.fieldErrors)[0]);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-3xl space-y-6">
        <PageHeader breadcrumbs={[{ label: 'Clients', href: '/ops/clients' }]} title="Client settings" />
        <ErrorState
          error={loadError}
          notFoundReason="missing-or-private"
          onRetry={() => void load()}
        />
      </div>
    );
  }

  if (!client) return null;

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Clients', href: '/ops/clients' },
          { label: client.name, href: `/ops/clients/${client.id}` },
          { label: 'Settings' },
        ]}
        title="Client settings"
        context={client.contactEmail ?? 'No contact email on file'}
        status={
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill label={clientStatusLabel(currentStatus)} tone={clientStatusTone(currentStatus)} />
            <span className="text-meta text-muted-foreground">
              Client since <Timestamp value={client.createdAt} dateOnly />
            </span>
          </span>
        }
      />

      {formError ? (
        // §3.4 — an error summary that links to the offending field, stated in
        // text rather than signalled by colour.
        <Alert variant="destructive" role="alert" id="form-error-summary">
          <AlertTitle>Not saved</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{formError}</p>
            {fieldErrors ? (
              <ul className="list-inside list-disc space-y-1">
                {Object.entries(fieldErrors).map(([field, messages]) => (
                  <li key={field}>
                    <a href={`#${field}`} className="underline underline-offset-4">
                      {messages.join(' ')}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {savedAt ? (
        <Alert>
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription>
            The server confirmed the change at{' '}
            <Timestamp value={savedAt} />. Re-open this page to confirm it persisted.
          </AlertDescription>
        </Alert>
      ) : null}

      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Contact</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field
              id="name"
              label="Client name"
              required
              value={name}
              onChange={setName}
              errors={fieldErrors?.name}
              disabled={saving}
            />
            <Field
              id="contactName"
              label="Contact name"
              value={contactName}
              onChange={setContactName}
              errors={fieldErrors?.contactName}
              disabled={saving}
            />
            <Field
              id="contactEmail"
              label="Contact email"
              type="email"
              value={contactEmail}
              onChange={setContactEmail}
              errors={fieldErrors?.contactEmail}
              disabled={saving}
              help="Used for report delivery. Changing it does not affect any client-portal login."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Relationship</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="status">
                Status
                <span className="ml-1 text-meta font-normal text-muted-foreground">(required)</span>
              </Label>
              <Select
                value={status}
                onValueChange={(value) => setStatus(value as ClientStatus)}
                disabled={saving}
              >
                <SelectTrigger id="status" aria-describedby="status-help">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                  <SelectItem value="churned">Churned</SelectItem>
                </SelectContent>
              </Select>
              <p id="status-help" className="text-meta text-muted-foreground">
                Current: {clientStatusLabel(currentStatus)}.
              </p>
            </div>

            <OwnerField
              id="ownerUserId"
              value={ownerUserId}
              onChange={setOwnerUserId}
              members={members}
              forbidden={membersForbidden}
              errors={fieldErrors?.ownerUserId}
              disabled={saving}
            />

            <div className="space-y-1.5">
              <Label htmlFor="notes">Internal notes</Label>
              <Textarea
                id="notes"
                name="notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                disabled={saving}
                rows={5}
              />
              <p className="text-meta text-muted-foreground">
                Internal only — never shown in the client portal.
              </p>
            </div>
          </CardContent>
        </Card>

        {needsReason ? (
          <PauseNotice
            status={status}
            reason={reason}
            onReasonChange={setReason}
            errors={fieldErrors?.reason}
            disabled={saving}
            projects={inFlightProjects}
          />
        ) : null}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => router.push(`/ops/clients/${client.id}`)}
            disabled={saving}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * The pause/churn explanation. §7.6's policy is the content: future paid
 * recurrence and publications stop, in-flight work does not. The projects
 * listed are real rows from the client detail read, so the statement "these
 * stay in flight" is about records that exist rather than a general promise.
 */
function PauseNotice({
  status,
  reason,
  onReasonChange,
  errors,
  disabled,
  projects,
}: {
  status: ClientStatus;
  reason: string;
  onReasonChange: (value: string) => void;
  errors?: string[];
  disabled?: boolean;
  projects: ProjectSummary[];
}) {
  const invalid = Boolean(errors?.length);
  const churn = status === 'churned';

  return (
    <Card className={churn ? 'border-danger' : 'border-warning'}>
      <CardHeader>
        <CardTitle className="text-subsection">
          {churn ? 'Churning this client' : 'Pausing this client'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="list-inside list-disc space-y-1.5 text-table text-muted-foreground">
          <li>Future scheduled runs and publications under the agreed policy stop.</li>
          <li>
            In-flight work is <strong className="font-medium text-foreground">not</strong> stopped or
            deleted. It stays exactly where it is, and stays visible as in-flight.
          </li>
          <li>
            Retained records — reports, messages, evidence — are unaffected. Nothing here deletes
            anything.
          </li>
        </ul>

        {projects.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-table">
              Projects that would stay in flight ({projects.length}):
            </p>
            <ul className="space-y-1">
              {projects.map((project) => (
                <li key={project.id} className="flex items-center gap-2 text-table">
                  <Link
                    href={`/projects/${project.id}`}
                    className="underline underline-offset-4"
                  >
                    {project.name}
                  </Link>
                  <span className="text-meta text-muted-foreground">{project.domain}</span>
                  {project.onboardingStatus === 'running' ? (
                    <StatusPill label="Setup running" tone="info" />
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-table text-muted-foreground">
            This client has no active projects, so nothing is left in flight.
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="reason">
            Reason
            <span className="ml-1 text-meta font-normal text-muted-foreground">
              (required) — recorded in the notes
            </span>
          </Label>
          <Textarea
            id="reason"
            name="reason"
            value={reason}
            onChange={(event) => onReasonChange(event.target.value)}
            disabled={disabled}
            rows={3}
            required
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? 'reason-error' : 'reason-help'}
          />
          {invalid ? (
            <p id="reason-error" className="text-meta text-danger-foreground">
              {errors?.join(' ')}
            </p>
          ) : (
            <p id="reason-help" className="text-meta text-muted-foreground">
              The client record has no dedicated {churn ? 'churn' : 'pause'} reason field yet
              (design_plan G06/G07). This text is appended to the internal notes above, prefixed
              with the change and its date, so it is not lost — and so you can see and edit exactly
              what will be stored.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The owner control. Renders a real picker for an admin, and states the
 * restriction for anyone else rather than showing an empty list.
 */
function OwnerField({
  id,
  value,
  onChange,
  members,
  forbidden,
  errors,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  members: TeamMember[] | null;
  forbidden: boolean;
  errors?: string[];
  disabled?: boolean;
}) {
  const invalid = Boolean(errors?.length);

  if (forbidden) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>Owner (delivery lead)</Label>
        <Input
          id={id}
          name={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          placeholder="Operator user id"
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${id}-error` : `${id}-help`}
        />
        {invalid ? (
          <p id={`${id}-error`} className="text-meta text-danger-foreground">
            {errors?.join(' ')}
          </p>
        ) : (
          <p id={`${id}-help`} className="text-meta text-muted-foreground">
            The operator directory (<code className="text-meta">GET /users</code>) is admin-only,
            and no role-scoped directory exists yet (design_plan G03). Enter the operator id
            directly, or ask an admin to assign the owner.
          </p>
        )}
      </div>
    );
  }

  // Not loaded yet (or the read failed): fall back to the id field rather than
  // an empty picker, which would read as "there are no operators".
  if (!members || members.length === 0) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>Owner (delivery lead)</Label>
        <Input
          id={id}
          name={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          placeholder={members ? 'No operators in the directory' : 'Loading directory…'}
          aria-describedby={`${id}-help`}
        />
        <p id={`${id}-help`} className="text-meta text-muted-foreground">
          {members
            ? 'The operator directory returned no entries. Enter an operator id directly.'
            : 'Enter the operator id — the directory has not loaded.'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Owner (delivery lead)</Label>
      <Select
        value={value || 'none'}
        onValueChange={(next) => onChange(next === 'none' ? '' : next)}
        disabled={disabled}
      >
        <SelectTrigger id={id} aria-describedby={`${id}-help`}>
          <SelectValue placeholder="No owner assigned" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No owner assigned</SelectItem>
          {members.map((member) => (
            <SelectItem key={member.id} value={member.id}>
              {member.name} · {OPERATOR_ROLE_LABEL[member.role] ?? member.role}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={`${id}-help`} className="text-meta text-muted-foreground">
        The lead is accountable for engagement quality and communication (§7.2). Leaving this
        unassigned is a real state, not a blank.
      </p>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  required,
  errors,
  help,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  errors?: string[];
  help?: string;
  disabled?: boolean;
}) {
  const invalid = Boolean(errors?.length);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span className="ml-1 text-meta font-normal text-muted-foreground">(required)</span>
        ) : null}
      </Label>
      <Input
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-error` : help ? `${id}-help` : undefined}
      />
      {invalid ? (
        <p id={`${id}-error`} className="text-meta text-danger-foreground">
          {errors?.join(' ')}
        </p>
      ) : help ? (
        <p id={`${id}-help`} className="text-meta text-muted-foreground">
          {help}
        </p>
      ) : null}
    </div>
  );
}

/** Moves focus to the field named in the error summary, by its DOM id. */
function focusField(name: string) {
  if (typeof document === 'undefined') return;
  const element = document.getElementById(name);
  if (element instanceof HTMLElement) element.focus();
}

/**
 * The reason line appended to the notes. The timestamp comes from
 * `formatTimestamp`, so it carries its zone — a bare local time would read
 * differently to a colleague in another timezone reading the same note later.
 */
function appendReason(notes: string, status: ClientStatus, reason: string): string {
  const stamp = formatTimestamp(new Date().toISOString());
  const label = status === 'churned' ? 'Churned' : status === 'paused' ? 'Paused' : 'Status changed';
  const entry = `[${label} ${stamp}] ${reason}`;
  return notes.trim() ? `${notes.trim()}\n\n${entry}` : entry;
}
