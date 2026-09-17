'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { UserMinus, UserPlus } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, clientActionMessage, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';
import {
  createPortalInvite,
  listPortalInvites,
  listPortalMembers,
  PORTAL_MEMBER_ROLE_DESCRIPTION,
  PORTAL_MEMBER_ROLE_LABEL,
  revokePortalInvite,
  revokePortalMember,
  updatePortalMember,
  type PortalInvite,
  type PortalMember,
  type PortalMemberRole,
} from '@/services/portal-access';

/**
 * CP14 — Collaborators.
 *
 * design_plan.md §4.5: *"Seat roles, invitations, project scope, revoke."*
 *
 * Three things the backend decides that this page must not pretend to decide
 * itself:
 *
 *  1. **Reading is open to every seat; changing is not.** `listPortalMembers`
 *     and `listPortalInvites` work for any seat, but create/update/revoke/invite
 *     require a `client-admin` seat and the server answers 403. The page renders
 *     the controls and handles that 403 as an explicit restriction — the `role`
 *     is deliberately not guessed from a client-side list, because the client
 *     surface exposes no "my seat" read (see the report note about
 *     `/api/portal/me`).
 *  2. **Scope is a seat property, not a filter.** An empty project list means
 *     *every* project of this client, which is why the scope editor shows "All
 *     projects" as a state rather than an empty selection.
 *  3. **Revoking is a soft delete.** The seat stops working; its history stays.
 *     The confirmation says so, and it says nothing can be un-done from here.
 *
 * An invitation's token is returned exactly once and is never stored; this page
 * shows it for hand-over and does not link to it (§5.1: no credentials in URLs
 * this app navigates to or logs).
 */
export default function ClientPeoplePage() {
  const [members, setMembers] = useState<PortalMember[] | null>(null);
  const [invites, setInvites] = useState<PortalInvite[] | null>(null);
  const [projects, setProjects] = useState<PortalProjectSummary[]>([]);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [editingScope, setEditingScope] = useState<PortalMember | null>(null);
  const [scopeDraft, setScopeDraft] = useState<string[]>([]);
  const [allProjects, setAllProjects] = useState(true);

  const [revokingMember, setRevokingMember] = useState<PortalMember | null>(null);
  const [revokingInvite, setRevokingInvite] = useState<PortalInvite | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<PortalMemberRole>('client-collaborator');
  const [inviteScopeAll, setInviteScopeAll] = useState(true);
  const [inviteScope, setInviteScope] = useState<string[]>([]);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const [memberList, inviteList, projectList] = await Promise.allSettled([
        listPortalMembers({ signal }),
        listPortalInvites({ signal }),
        listPortalProjectSummaries({ signal }),
      ]);
      if (memberList.status === 'rejected') throw memberList.reason;
      setMembers(memberList.value);
      if (inviteList.status === 'fulfilled') setInvites(inviteList.value);
      if (projectList.status === 'fulfilled') setProjects(projectList.value);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(toApiError(caught));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /** Project ids → names. An empty list means every project, and says so. */
  const scopeLabels = useCallback(
    (projectIds: string[]): string => {
      if (projectIds.length === 0) return 'All projects';
      const names = projectIds.map(
        (id) => projects.find((project) => project.id === id)?.name ?? 'a project not on your account',
      );
      return names.join(', ');
    },
    [projects],
  );

  async function changeRole(member: PortalMember, role: PortalMemberRole) {
    setBusyId(member.id);
    setActionError(null);
    try {
      await updatePortalMember(member.id, { role });
      await load();
    } catch (caught) {
      setActionError(describeFailure(caught, 'The role could not be changed.'));
    } finally {
      setBusyId(null);
    }
  }

  async function saveScope() {
    if (!editingScope) return;
    setBusyId(editingScope.id);
    setActionError(null);
    try {
      // An empty list is the "every project" state, not an empty selection.
      await updatePortalMember(editingScope.id, { projectIds: allProjects ? [] : scopeDraft });
      setEditingScope(null);
      await load();
    } catch (caught) {
      setActionError(describeFailure(caught, 'The project scope could not be saved.'));
    } finally {
      setBusyId(null);
    }
  }

  async function onRevokeMember(member: PortalMember) {
    setBusyId(member.id);
    try {
      await revokePortalMember(member.id);
      await load();
    } catch (caught) {
      setActionError(describeFailure(caught, 'The seat could not be revoked.'));
    } finally {
      setBusyId(null);
    }
  }

  async function onRevokeInvite(invite: PortalInvite) {
    setBusyId(invite.id);
    try {
      await revokePortalInvite(invite.id);
      await load();
    } catch (caught) {
      setActionError(describeFailure(caught, 'The invitation could not be revoked.'));
    } finally {
      setBusyId(null);
    }
  }

  async function onInvite() {
    setBusyId('invite');
    setActionError(null);
    try {
      await createPortalInvite({
        email: inviteEmail.trim(),
        role: inviteRole,
        projectIds: inviteScopeAll ? [] : inviteScope,
      });
      setInviteEmail('');
      setInviteScope([]);
      setInviteScopeAll(true);
      await load();
    } catch (caught) {
      setActionError(describeFailure(caught, 'The invitation could not be created.'));
    } finally {
      setBusyId(null);
    }
  }

  const memberColumns = useMemo<ColumnDef<PortalMember>[]>(
    () => [
      {
        key: 'person',
        header: 'Person',
        accessor: (row) => row.name || row.email,
        sortable: true,
        render: (row) => (
          <span className="min-w-0">
            <span className="block font-medium">{row.name || row.email}</span>
            {row.name ? (
              <span className="block text-meta text-muted-foreground">{row.email}</span>
            ) : null}
          </span>
        ),
      },
      {
        key: 'role',
        header: 'Access',
        accessor: (row) => PORTAL_MEMBER_ROLE_LABEL[row.role],
        sortable: true,
        render: (row) => (
          <Select
            value={row.role}
            disabled={busyId !== null}
            onValueChange={(value) => void changeRole(row, value as PortalMemberRole)}
          >
            <SelectTrigger
              className="w-44"
              aria-label={`Access level for ${row.name || row.email}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PORTAL_MEMBER_ROLE_LABEL) as PortalMemberRole[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {PORTAL_MEMBER_ROLE_LABEL[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ),
      },
      {
        key: 'scope',
        header: 'Project scope',
        accessor: (row) => scopeLabels(row.projectIds),
        render: (row) => (
          <span className="text-table">
            {scopeLabels(row.projectIds)}
            {row.projectIds.length === 0 ? (
              <span className="block text-meta text-muted-foreground">
                Every project on your account, including ones added later
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        accessor: (row) => row.status,
        render: (row) => (
          <StatusPill
            label={row.status === 'active' ? 'Active' : 'Suspended'}
            tone={row.status === 'active' ? 'success' : 'unmeasured'}
          />
        ),
      },
      {
        key: 'actions',
        header: 'Actions',
        alwaysVisible: true,
        render: (row) => (
          <span className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busyId !== null}
              onClick={() => {
                setEditingScope(row);
                setAllProjects(row.projectIds.length === 0);
                setScopeDraft(row.projectIds);
              }}
            >
              Change scope
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busyId !== null}
              onClick={() => setRevokingMember(row)}
            >
              Revoke
            </Button>
          </span>
        ),
      },
    ],
    // `busyId` and `scopeLabels` change what the cells do; the column set is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busyId, scopeLabels],
  );

  const inviteColumns = useMemo<ColumnDef<PortalInvite>[]>(
    () => [
      { key: 'email', header: 'Email', accessor: (row) => row.email, sortable: true },
      {
        key: 'role',
        header: 'Access',
        accessor: (row) => PORTAL_MEMBER_ROLE_LABEL[row.role],
        sortable: true,
      },
      {
        key: 'scope',
        header: 'Project scope',
        accessor: (row) => scopeLabels(row.projectIds),
      },
      {
        key: 'status',
        header: 'Status',
        accessor: (row) => row.status,
        render: (row) => (
          <StatusPill label={inviteStatusLabel(row.status)} tone={inviteStatusTone(row.status)} />
        ),
      },
      {
        key: 'expires',
        header: 'Expires',
        accessor: (row) => row.expiresAt,
        render: (row) => <Timestamp value={row.expiresAt} dateOnly />,
        sortValue: (row) => row.expiresAt,
      },
      {
        key: 'actions',
        header: 'Actions',
        alwaysVisible: true,
        render: (row) =>
          row.status === 'pending' ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busyId !== null}
              onClick={() => setRevokingInvite(row)}
            >
              Revoke
            </Button>
          ) : (
            <span className="text-meta text-muted-foreground">No action</span>
          ),
      },
    ],
    [busyId, scopeLabels],
  );

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="People" />
        <ErrorState
          error={error}
          onRetry={() => void load()}
          restrictedAction="see who has access to your account"
          permittedPath="Ask your delivery lead, who can manage seats from their side."
          showServerMessage={false}
        />
      </div>
    );
  }

  if (!members) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="People"
        context="Who can sign in to your Cailyx account, and which projects they can see."
      />

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby="seats-heading" className="space-y-3">
        <h2 id="seats-heading" className="text-subsection font-semibold tracking-tight">
          Seats
        </h2>
        <DataTable
          columns={memberColumns}
          rows={members}
          getRowId={(row) => row.id}
          caption="Seats on your account, with their access level and project scope"
          emptyState={
            <EmptyState
              variant="not-measured"
              subject="seats on this account"
              prerequisite="Nobody has been given a seat yet. Your delivery lead can create the first login."
            />
          }
          minTableWidth="60rem"
        />
        <p className="text-meta text-muted-foreground">
          {PORTAL_MEMBER_ROLE_DESCRIPTION['client-collaborator']} A revoked seat
          stops working immediately; the record that it existed is kept.
        </p>
      </section>

      <section aria-labelledby="invites-heading" className="space-y-3">
        <h2 id="invites-heading" className="text-subsection font-semibold tracking-tight">
          Invitations
        </h2>
        <Card>
          <CardHeader>
            <CardTitle className="text-table font-medium">Invite someone</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1 space-y-1.5">
                <Label htmlFor="people-invite-email">Email address</Label>
                <Input
                  id="people-invite-email"
                  type="email"
                  autoComplete="email"
                  value={inviteEmail}
                  placeholder="colleague@example.com"
                  onChange={(event) => setInviteEmail(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="people-invite-role">Access</Label>
                <Select
                  value={inviteRole}
                  onValueChange={(value) => setInviteRole(value as PortalMemberRole)}
                >
                  <SelectTrigger id="people-invite-role" className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PORTAL_MEMBER_ROLE_LABEL) as PortalMemberRole[]).map((value) => (
                      <SelectItem key={value} value={value}>
                        {PORTAL_MEMBER_ROLE_LABEL[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-meta text-muted-foreground">{PORTAL_MEMBER_ROLE_DESCRIPTION[inviteRole]}</p>

            <ProjectScopePicker
              projects={projects}
              all={inviteScopeAll}
              selected={inviteScope}
              onAllChange={setInviteScopeAll}
              onSelectedChange={setInviteScope}
              idPrefix="invite"
            />

            <Button
              size="sm"
              disabled={busyId !== null || inviteEmail.trim() === ''}
              onClick={() => void onInvite()}
            >
              <UserPlus aria-hidden="true" className="mr-2 h-4 w-4" />
              {busyId === 'invite' ? 'Inviting…' : 'Send invitation'}
            </Button>
            <p className="text-meta text-muted-foreground">
              An invitation is single-use and expires. The person accepting it
              sets their own password — nobody here ever sees it.
            </p>
          </CardContent>
        </Card>

        {invites === null ? (
          <p className="text-table text-muted-foreground">
            Invitations could not be read just now. Reload to see the current list.
          </p>
        ) : (
          <DataTable
            columns={inviteColumns}
            rows={invites}
            getRowId={(row) => row.id}
            caption="Invitations, with their derived status"
            emptyState={
              <EmptyState
                variant="not-measured"
                subject="invitations"
                prerequisite="None have been sent. Use the form above to invite a colleague."
              />
            }
            minTableWidth="56rem"
          />
        )}
      </section>

      {/* ── Scope editor ─────────────────────────────────────────────── */}
      <Dialog
        open={editingScope !== null}
        onOpenChange={(open) => {
          if (!open) setEditingScope(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Project scope for {editingScope?.name || editingScope?.email || 'this seat'}
            </DialogTitle>
            <DialogDescription>
              A seat sees only the projects you list here. Choosing every project
              also covers projects added later — a scoped seat does not.
            </DialogDescription>
          </DialogHeader>

          <ProjectScopePicker
            projects={projects}
            all={allProjects}
            selected={scopeDraft}
            onAllChange={setAllProjects}
            onSelectedChange={setScopeDraft}
            idPrefix="scope"
          />

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingScope(null)}>
              Cancel
            </Button>
            <Button disabled={busyId !== null} onClick={() => void saveScope()}>
              {busyId !== null ? 'Saving…' : 'Save scope'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Revocations ──────────────────────────────────────────────── */}
      <ConfirmDialog
        open={revokingMember !== null}
        onOpenChange={(open) => {
          if (!open) setRevokingMember(null);
        }}
        title="Revoke this seat?"
        targetLabel="Person"
        target={revokingMember?.email ?? ''}
        confirmLabel="Revoke access"
        destructive
        effect="They lose access to every project this seat covered, at their next request. There is no way to restore the seat from this page — you would invite them again."
        scope="What they did while they had access stays in the record. Nothing collected is deleted."
        onConfirm={() => {
          if (revokingMember) return onRevokeMember(revokingMember);
        }}
        onConfirmed={() => setRevokingMember(null)}
      />

      <ConfirmDialog
        open={revokingInvite !== null}
        onOpenChange={(open) => {
          if (!open) setRevokingInvite(null);
        }}
        title="Revoke this invitation?"
        targetLabel="Email"
        target={revokingInvite?.email ?? ''}
        confirmLabel="Revoke invitation"
        destructive
        effect="The invitation link stops working immediately. If they still need access, send a new invitation."
        scope="An invitation that was already accepted cannot be revoked here — revoke the seat instead."
        onConfirm={() => {
          if (revokingInvite) return onRevokeInvite(revokingInvite);
        }}
        onConfirmed={() => setRevokingInvite(null)}
      />

      <p className="flex items-start gap-2 text-meta text-muted-foreground">
        <UserMinus aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Managing seats and invitations needs an administrator seat on your
          account. If the controls above are refused, ask whoever set up your
          account — the refusal is the server’s, not a display choice.
        </span>
      </p>
    </div>
  );
}

/**
 * Project scope: "all projects" or an explicit list.
 *
 * The two states are mutually exclusive because the backend treats an empty
 * list as *every* project — rendering an empty checklist as "no projects" would
 * invert its meaning.
 */
function ProjectScopePicker({
  projects,
  all,
  selected,
  onAllChange,
  onSelectedChange,
  idPrefix,
}: {
  projects: PortalProjectSummary[];
  all: boolean;
  selected: string[];
  onAllChange: (value: boolean) => void;
  onSelectedChange: (value: string[]) => void;
  idPrefix: string;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-table font-medium">Project scope</legend>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${idPrefix}-all`}
          checked={all}
          onCheckedChange={(checked) => onAllChange(checked === true)}
        />
        <Label htmlFor={`${idPrefix}-all`} className="font-normal">
          Every project on the account (including ones added later)
        </Label>
      </div>

      {projects.length === 0 ? (
        <p className="text-meta text-muted-foreground">
          Your account has no projects to scope to yet.
        </p>
      ) : (
        <div className="space-y-2 pl-6">
          {projects.map((project) => (
            <div key={project.id} className="flex items-center gap-2">
              <Checkbox
                id={`${idPrefix}-project-${project.id}`}
                checked={!all && selected.includes(project.id)}
                disabled={all}
                onCheckedChange={(checked) => {
                  const next =
                    checked === true
                      ? [...selected, project.id]
                      : selected.filter((id) => id !== project.id);
                  onSelectedChange(next);
                }}
              />
              <Label htmlFor={`${idPrefix}-project-${project.id}`} className="font-normal">
                {project.name}
                <span className="ml-2 font-mono text-meta text-muted-foreground">
                  {project.domain}
                </span>
              </Label>
            </div>
          ))}
        </div>
      )}
      {all ? (
        <p className="text-meta text-muted-foreground">
          Individual projects are disabled while every project is selected.
        </p>
      ) : null}
    </fieldset>
  );
}

function inviteStatusLabel(status: PortalInvite['status']): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'accepted':
      return 'Accepted';
    case 'expired':
      return 'Expired';
    case 'revoked':
      return 'Revoked';
  }
}

function inviteStatusTone(status: PortalInvite['status']) {
  switch (status) {
    case 'pending':
      return 'warning' as const;
    case 'accepted':
      return 'success' as const;
    case 'expired':
      return 'unmeasured' as const;
    case 'revoked':
      return 'unmeasured' as const;
  }
}

/** A 403 here is a policy answer, not a failure to retry — say which. */
function describeFailure(caught: unknown, fallback: string): string {
  if (caught && typeof caught === 'object' && 'kind' in caught) {
    const kind = (caught as { kind?: string }).kind;
    if (kind === 'forbidden') {
      return 'Only an administrator seat on your account can manage people. Nothing was changed.';
    }
    if (kind === 'conflict') {
      return 'That conflicts with the current state — reload the page and try again.';
    }
    if (kind === 'unauthenticated') {
      return 'Your session has expired. Sign in again to continue.';
    }
  }
  return clientActionMessage(caught, fallback);
}
