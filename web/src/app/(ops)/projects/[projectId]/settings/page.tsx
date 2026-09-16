'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { projectStatusLabel, projectStatusTone } from '@/lib/status-tones';
import {
  LIFECYCLE_TRANSITIONS,
  PROJECT_STATUS_LABEL,
  deleteProject,
  getProjectDetail,
  transitionProject,
  updateProject,
  type ProjectDetailWire,
} from '@/services/projects';
import type { ProjectStatus } from '@/services/types';

/**
 * PJ02 — Project settings.
 *
 * design_plan.md §4.3: *"Metadata, lifecycle transition, client association,
 * domain identity, archive/delete"*, support "Core E; **domain edit/client
 * attach G04**".
 *
 * The support column is the honest map of what can be built, and this screen
 * follows it rather than filling the gaps in:
 *
 *  - **Metadata** is editable: `PATCH /projects/:id` takes name, category,
 *    clientName and notes.
 *  - **The lifecycle transition** is its own action, not a status field on
 *    this form. §8.1 says to "use the transition action rather than generic
 *    PATCH to bypass its policy", so the two are deliberately different
 *    controls, and the transition control shows the server's allowed moves
 *    for the current status and states what the move means.
 *  - **Client association and domain identity are not editable, and not
 *    readable either.** `UpdateProjectDto` carries no `domain` and no
 *    `clientId`, and `GET /projects/:id` does not return them. That is G04,
 *    and it is rendered as an explicit unavailability with the reason — a
 *    read-only field showing "—" would say the project has no client, which
 *    is a different and possibly false claim.
 *  - **Archive** is a lifecycle transition and reversible (archived →
 *    diagnostic), so it gets a stated-effect confirmation, not a destructive
 *    one. **Delete** is admin-only, cascades, and cannot be undone, so it
 *    takes the typed confirmation `ConfirmDialog` requires.
 */
export default function ProjectSettingsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const router = useRouter();

  const [project, setProject] = useState<ProjectDetailWire | null>(null);
  const [loadError, setLoadError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [clientName, setClientName] = useState('');
  const [notes, setNotes] = useState('');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]> | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setLoadError(null);
        setLoading(true);
        const detail = await getProjectDetail(projectId, { signal });
        setProject(detail);
        setName(detail.name);
        setCategory(detail.category ?? '');
        setClientName(detail.clientName ?? '');
        setNotes(detail.notes ?? '');
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setLoadError(toApiError(caught));
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function onSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !project) return;

    setFormError(null);
    setFieldErrors(null);
    setSavedNotice(null);

    if (!name.trim()) {
      setFieldErrors({ name: ['Project name is required.'] });
      setFormError('Enter the project name before saving.');
      return;
    }

    setSaving(true);
    try {
      await updateProject(projectId, {
        name: name.trim(),
        category: category.trim() || undefined,
        clientName: clientName.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      setSavedAt(new Date().toISOString());
      await load();
    } catch (caught) {
      const error = toApiError(caught);
      setFieldErrors(error.fieldErrors ?? null);
      setFormError('Your change was not saved. Nothing on the server was modified.');
    } finally {
      setSaving(false);
    }
  }

  async function onTransition(to: ProjectStatus) {
    setTransitionError(null);
    try {
      await transitionProject(projectId, to);
      setSavedNotice(`Lifecycle moved to ${PROJECT_STATUS_LABEL[to]}.`);
      await load();
    } catch (caught) {
      const error = toApiError(caught);
      // A 409 here is the server's transition policy, with its own explanation.
      setTransitionError(error.message);
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-3xl space-y-6">
        <PageHeader breadcrumbs={[{ label: 'Projects', href: '/ops/projects' }]} title="Settings" />
        <ErrorState error={loadError} onRetry={() => void load()} />
      </div>
    );
  }

  if (!project) return null;

  const status = project.status;
  const allowed = LIFECYCLE_TRANSITIONS[status] ?? [];
  const nonArchive = allowed.filter((next) => next !== 'archived');
  const canArchive = allowed.includes('archived');

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Projects', href: '/ops/projects' },
          { label: project.name, href: `/projects/${project.id}` },
          { label: 'Settings' },
        ]}
        title="Project settings"
        context={project.domain}
        status={<StatusPill label={projectStatusLabel(status)} tone={projectStatusTone(status)} />}
      />

      {formError ? (
        <Alert variant="destructive" role="alert">
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

      {savedAt || savedNotice ? (
        <Alert>
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription>
            {savedNotice ? `${savedNotice} ` : ''}
            The server confirmed the change{savedAt ? ' at ' : ''}
            {savedAt ? <Timestamp value={savedAt} /> : null}. The values below are the server&apos;s,
            re-read rather than assumed.
          </AlertDescription>
        </Alert>
      ) : null}

      <form onSubmit={onSave} noValidate className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Metadata</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">
                Project name
                <span className="ml-1 text-meta font-normal text-muted-foreground">(required)</span>
              </Label>
              <Input
                id="name"
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                disabled={saving}
                aria-invalid={fieldErrors?.name ? true : undefined}
                aria-describedby={fieldErrors?.name ? 'name-error' : undefined}
              />
              {fieldErrors?.name ? (
                <p id="name-error" className="text-meta text-danger-foreground">
                  {fieldErrors.name.join(' ')}
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="category">Category</Label>
              <Input
                id="category"
                name="category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                disabled={saving}
                aria-describedby="category-help"
              />
              <p id="category-help" className="text-meta text-muted-foreground">
                Seeded by intake enrichment. Used to seed keyword research and competitor discovery.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="clientName">Client name (on the project record)</Label>
              <Input
                id="clientName"
                name="clientName"
                value={clientName}
                onChange={(event) => setClientName(event.target.value)}
                disabled={saving}
                aria-describedby="clientName-help"
              />
              <p id="clientName-help" className="text-meta text-muted-foreground">
                A free-text label on the project. This is <strong className="font-medium">not</strong>{' '}
                the client association — see below.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="notes">Internal notes</Label>
              <Textarea
                id="notes"
                name="notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                disabled={saving}
                rows={4}
              />
              <p className="text-meta text-muted-foreground">
                Operator-only. Not shown in the client portal or in reports.
              </p>
            </div>

            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? 'Saving…' : 'Save metadata'}
            </Button>
          </CardContent>
        </Card>
      </form>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Lifecycle</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-table text-muted-foreground">
            The lifecycle records what the client has engaged. It is separate from onboarding
            progress, so a project can be a retainer whose setup pipeline is still running.
          </p>

          {transitionError ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>Transition refused</AlertTitle>
              <AlertDescription>{transitionError}</AlertDescription>
            </Alert>
          ) : null}

          {nonArchive.length === 0 ? (
            <p className="text-table text-muted-foreground">
              No forward transition is available from {PROJECT_STATUS_LABEL[status]}.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-table text-muted-foreground">
                Move to:
              </span>
              {nonArchive.map((next) => (
                <Button
                  key={next}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void onTransition(next)}
                  disabled={saving}
                >
                  {PROJECT_STATUS_LABEL[next]}
                </Button>
              ))}
            </div>
          )}

          <p className="text-meta text-muted-foreground">
            Allowed from {PROJECT_STATUS_LABEL[status]}:{' '}
            {allowed.length ? allowed.map((next) => PROJECT_STATUS_LABEL[next]).join(', ') : 'none'}.
            The server validates the move and answers 409 if it is not permitted; this list only
            describes what it will accept.
          </p>

          {canArchive ? (
            <div className="space-y-2 border-t border-border pt-4">
              <p className="text-table">
                <strong className="font-medium">Archive</strong> hides the project from the active
                portfolio without deleting anything. It is reversible — an archived project can be
                moved back to Diagnostic.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => setArchiveOpen(true)}
                disabled={saving}
              >
                Archive project
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Domain identity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-body font-medium">{project.domain}</p>
          <p className="text-table text-muted-foreground">
            Every measurement on this project is keyed to this domain. It cannot be edited here:
            <code className="text-meta"> PATCH /projects/:id</code> accepts no <code className="text-meta">domain</code>{' '}
            field, and the domain carries a uniqueness constraint that is what makes a duplicate
            detectable at all. Changing it would silently re-point every stored audit at a different
            site.
          </p>
          <EmptyState
            variant="not-measured"
            subject="domain editing"
            prerequisite="a domain-change contract that records the old value and re-scopes existing measurements (design_plan G04)"
            layout="inline"
          >
            <p>
              If the project was created against the wrong domain, the honest fix today is a new
              project for the correct domain — the old one keeps its history rather than having it
              re-attributed.
            </p>
          </EmptyState>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Client association</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            variant="not-measured"
            subject="this project's client association"
            prerequisite="a project read that returns clientId, and an endpoint that can change it (design_plan G04)"
            layout="panel"
          >
            <p>
              The project detail route does not return <code className="text-meta">clientId</code>,
              and <code className="text-meta">PATCH /projects/:id</code> does not accept it. So this
              screen cannot show which client owns this project, and cannot attach or detach one.
            </p>
            <p>
              What is shown above is the free-text <em>client name</em> field, which is a label, not
              the association. Reading it as the association would be wrong whenever the two
              disagree.
            </p>
            <p>
              To see which client a project belongs to, open the client&apos;s own page — it lists
              its projects.
            </p>
            <p className="pt-1">
              <Link href="/ops/clients" className="underline underline-offset-4">
                Browse clients
              </Link>
            </p>
          </EmptyState>
        </CardContent>
      </Card>

      <Card className="border-danger">
        <CardHeader>
          <CardTitle className="text-subsection">Delete this project</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-table">
            Deleting removes the project and everything bound to it. It cannot be undone, and there
            is no restore. Archiving is the reversible alternative above.
          </p>
          <p className="text-table text-muted-foreground">
            This action is restricted to administrators at the API level, so a delivery lead who
            presses it will receive a 403 with no retry offered.
          </p>
          <Button
            type="button"
            variant="destructive"
            onClick={() => setDeleteOpen(true)}
            disabled={saving}
          >
            Delete project
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title="Archive this project"
        confirmLabel="Archive project"
        targetLabel="Project"
        target={project.name}
        effect={
          <>
            The project moves to <strong className="font-medium">Archived</strong>. It stops
            appearing in the active portfolio and in cross-project views, and no new work is planned
            against it.
          </>
        }
        scope="Nothing is deleted. Reports, audits and work history are retained, and this can be reversed by moving the project back to Diagnostic."
        onConfirm={async () => {
          await transitionProject(projectId, 'archived');
        }}
        onConfirmed={() => {
          setArchiveOpen(false);
          setSavedNotice('Project archived.');
          void load();
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this project"
        confirmLabel="Delete project"
        destructive
        targetLabel="Domain"
        target={project.domain}
        effect={
          <>
            The project and the records bound to it are deleted permanently. This cannot be undone
            and there is no restore.
          </>
        }
        scope={
          <>
            Deleting a project does not delete its client, its conversations, or any other project.
            Technical audits that reference this project by id are not removed by this action.
          </>
        }
        onConfirm={async () => {
          await deleteProject(projectId);
        }}
        onConfirmed={() => {
          setDeleteOpen(false);
          router.push('/ops/projects');
        }}
      />
    </div>
  );
}
