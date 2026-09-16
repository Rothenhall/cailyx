'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, MoreHorizontal, Pencil, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useSession } from '@/hooks/useSession';
import type { OperatorRole, SafeUser } from '@/services/types';
import {
  createOperator,
  deleteOperator,
  listOperatorRoles,
  listOperators,
  resetOperatorPassword,
  updateOperator,
} from '@/services/admin';

/**
 * OP16 — People.
 *
 * design_plan.md §4.2: *"Operator list/create/edit role/reset password/delete,
 * safeguards and removal impact."* The administration family adds *"explanation
 * above high-impact actions, explicit save/test"*.
 *
 * ## Where the enforcement actually lives
 *
 * §2.2 is explicit that *"hiding a button does not enforce this policy"*. Every
 * rule on this screen is enforced by the backend from the JWT:
 *
 *   - the route is `@Roles('admin')`, so a non-admin gets a 403 and this page
 *     renders §3.5's `insufficient-role` state rather than a client-side gate;
 *   - the **last admin cannot be demoted** (409) or **deleted** (409);
 *   - an operator **cannot delete their own account** here (400).
 *
 * Those three are also stated in words above the table, because §10.4 wants the
 * consequence understood *before* the action, not discovered as a 409. Where
 * this screen disables a control it is because the server would refuse it —
 * never as the thing that makes the refusal true.
 *
 * ## Removal impact
 *
 * The confirm dialog says what a delete actually reaches: the account and its
 * revoked sessions, not the work the person owned. Records they created stay
 * and are attributed to them in the activity log, which is append-only and
 * carries the actor independently of whether that account still exists.
 */

const PASSWORD_MIN_LENGTH = 10;

export default function AdminPeoplePage() {
  const session = useSession();
  const [operators, setOperators] = useState<SafeUser[] | null>(null);
  const [roles, setRoles] = useState<OperatorRole[]>([]);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [dialog, setDialog] = useState<'create' | 'edit' | 'reset' | null>(null);
  const [active, setActive] = useState<SafeUser | null>(null);
  const [deleting, setDeleting] = useState<SafeUser | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const [list, catalogue] = await Promise.all([
        listOperators({ signal }),
        listOperatorRoles({ signal }),
      ]);
      setOperators(list.users);
      setRoles(catalogue.roles as OperatorRole[]);
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

  // The last-admin rules are stated in terms of a count this screen can see.
  // It is a *reason* for the wording, never the enforcement: the backend
  // re-checks the count inside the write.
  const adminCount = useMemo(
    () => (operators ?? []).filter((operator) => operator.role === 'admin').length,
    [operators],
  );

  const closeDialog = useCallback(() => {
    setDialog(null);
    setActive(null);
  }, []);

  const columns = useMemo<ReadonlyArray<ColumnDef<SafeUser>>>(
    () => [
      {
        key: 'name',
        header: 'Operator',
        accessor: (row) => row.name,
        sortable: true,
        render: (row) => {
          const isSelf = session.user?.id === row.id;
          return (
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{row.name}</span>
                {isSelf ? (
                  <Badge variant="outline" className="text-meta">
                    You
                  </Badge>
                ) : null}
              </div>
              <div className="truncate text-meta text-muted-foreground">{row.email}</div>
            </div>
          );
        },
        searchText: (row) => `${row.name} ${row.email}`,
      },
      {
        key: 'role',
        header: 'Role',
        accessor: (row) => row.role,
        sortable: true,
        width: 160,
        render: (row) => (
          <StatusPill
            // Admin passes every operator role check (§2.2); the label says so
            // rather than letting the word "admin" imply more than it does.
            label={row.role}
            tone={row.role === 'admin' ? 'info' : 'neutral'}
          />
        ),
      },
      {
        key: 'type',
        header: 'Account type',
        accessor: (row) => row.type,
        width: 130,
        render: (row) => (
          <span className="text-muted-foreground">
            {row.type === 'operator' ? 'Operator' : 'Client user'}
          </span>
        ),
      },
      {
        key: 'passwordState',
        header: 'Password',
        accessor: (row) => (row.mustChangePassword ? 'must-change' : 'set'),
        width: 170,
        render: (row) => (
          <StatusPill
            label={row.mustChangePassword ? 'Temporary — must change' : 'Set by the operator'}
            tone={row.mustChangePassword ? 'warning' : 'neutral'}
          />
        ),
      },
      {
        key: 'createdAt',
        header: 'Added',
        accessor: (row) => row.createdAt,
        sortable: true,
        width: 190,
        render: (row) => <Timestamp value={row.createdAt} />,
      },
      {
        key: 'actions',
        header: '',
        alwaysVisible: true,
        width: 60,
        align: 'right',
        render: (row) => {
          const isSelf = session.user?.id === row.id;
          const isLastAdmin = row.role === 'admin' && adminCount <= 1;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Actions for ${row.name}`}
                  className="h-8 w-8 p-0"
                >
                  <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{row.email}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    setActive(row);
                    setDialog('edit');
                  }}
                >
                  <Pencil aria-hidden="true" className="mr-2 h-4 w-4" />
                  Edit name and role
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    setActive(row);
                    setDialog('reset');
                  }}
                >
                  <KeyRound aria-hidden="true" className="mr-2 h-4 w-4" />
                  Reset password
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  // Destructive actions live in the row menu, never as a
                  // primary button (§4 portfolio family).
                  className="text-danger focus:text-danger"
                  disabled={isSelf || isLastAdmin}
                  onSelect={() => {
                    if (isSelf || isLastAdmin) return;
                    setDeleting(row);
                  }}
                >
                  <Trash2 aria-hidden="true" className="mr-2 h-4 w-4" />
                  Delete operator
                </DropdownMenuItem>
                {isSelf || isLastAdmin ? (
                  <DropdownMenuItem disabled className="text-meta text-muted-foreground">
                    {isSelf
                      ? 'You cannot delete your own account here'
                      : 'The last admin cannot be deleted'}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [adminCount, session.user?.id],
  );

  // §3.5 "Insufficient role" — a copied link or a role change lands here, and
  // the answer is an explanation of what is restricted and what is permitted.
  if (error?.kind === 'forbidden') {
    return (
      <div className="space-y-6">
        <PageHeader title="People" />
        <EmptyState
          variant="insufficient-role"
          restrictedAction="manage operator accounts"
          permittedPath="Ask an administrator. Your own name and password live under Account."
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="People" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!operators) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="People"
        context={`${operators.length} account${operators.length === 1 ? '' : 's'}, ${adminCount} with the admin role.`}
        primaryAction={{
          label: 'Add operator',
          icon: <Plus aria-hidden="true" className="mr-2 h-4 w-4" />,
          onClick: () => setDialog('create'),
        }}
      />

      {/*
        The safeguards, in words, above the high-impact controls rather than
        only in the 409 that follows one. Each sentence names the rule and who
        holds the exception.
      */}
      <Alert>
        <ShieldAlert aria-hidden="true" className="h-4 w-4" />
        <AlertTitle>Safeguards on these actions</AlertTitle>
        <AlertDescription>
          <ul className="list-disc space-y-1 pl-4">
            <li>
              The <strong>last admin</strong> cannot be demoted or deleted. Add
              a second admin first.
            </li>
            <li>You cannot delete your own account from this screen.</li>
            <li>
              A password reset takes effect immediately and{' '}
              <strong>revokes that operator&rsquo;s sessions</strong>; the number
              revoked is reported when it completes.
            </li>
            <li>
              An invitation email is not sent. Hand the temporary password to
              the operator directly — it is displayed once and never returned by
              a later read.
            </li>
          </ul>
        </AlertDescription>
      </Alert>

      <DataTable
        caption="Operator accounts"
        columns={columns}
        rows={operators}
        getRowId={(row) => row.id}
        searchable
        searchPlaceholder="Search by name or email…"
        defaultSort={{ key: 'name', direction: 'asc' }}
        filters={[
          {
            id: 'role',
            label: 'Role',
            options: roles.map((role) => ({ value: role, label: role })),
            getValue: (row) => row.role,
          },
          {
            id: 'type',
            label: 'Account type',
            options: [
              { value: 'operator', label: 'Operator' },
              { value: 'client', label: 'Client user' },
            ],
            getValue: (row) => row.type,
          },
        ]}
        emptyState={
          // An empty people list is not a filtered list: there is genuinely no
          // operator to show, and "clear the filters" would be wrong advice.
          <EmptyState
            variant="not-measured"
            subject="operator accounts"
            prerequisite="At least one operator account exists — the account you are signed in as is the first one."
          >
            The list came back empty. That is unexpected on this screen: a signed-in
            admin is itself an operator account.
          </EmptyState>
        }
      />

      <CreateOperatorDialog
        open={dialog === 'create'}
        onOpenChange={(open) => (open ? setDialog('create') : closeDialog())}
        roles={roles}
        onCreated={() => {
          closeDialog();
          void load();
        }}
      />

      {active ? (
        <EditOperatorDialog
          // Keyed on the record: switching rows must remount, or the form
          // would keep the previous operator's values in its state.
          key={`edit-${active.id}`}
          operator={active}
          open={dialog === 'edit'}
          onOpenChange={(open) => (open ? setDialog('edit') : closeDialog())}
          roles={roles}
          isLastAdmin={active.role === 'admin' && adminCount <= 1}
          onSaved={() => {
            closeDialog();
            void load();
          }}
        />
      ) : null}

      {active ? (
        <ResetPasswordDialog
          key={`reset-${active.id}`}
          operator={active}
          open={dialog === 'reset'}
          onOpenChange={(open) => (open ? setDialog('reset') : closeDialog())}
          onReset={() => {
            closeDialog();
            void load();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this operator account?"
        targetLabel="Account"
        target={deleting?.email ?? ''}
        confirmLabel="Delete operator"
        destructive
        effect="The account is removed and its sign-in stops immediately. This cannot be undone."
        scope="Records this person created are not deleted. Their activity-log entries stay and keep naming them as the actor, because that log is append-only."
        onConfirm={async () => {
          if (!deleting) return;
          await deleteOperator(deleting.id);
        }}
        onConfirmed={() => {
          setDeleting(null);
          void load();
        }}
        onReload={() => void load()}
      />
    </div>
  );
}

/** Shared form scaffolding: an error summary that links to the offending field. */
function FormError({ error, idPrefix }: { error: ReturnType<typeof toApiError> | null; idPrefix: string }) {
  if (!error) return null;
  return (
    <ErrorState
      error={error}
      layout="inline"
      fieldIdPrefix={idPrefix}
      preserveNotice="Nothing you typed has been cleared."
    />
  );
}

function CreateOperatorDialog({
  open,
  onOpenChange,
  roles,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: OperatorRole[];
  onCreated: () => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<OperatorRole>('delivery-lead');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busy, setBusy] = useState(false);

  const roleDescriptions: Record<string, string> = {
    admin: 'Everything, including people, rubrics, budgets and organization settings.',
    'delivery-lead': 'Client and project delivery, budget ceilings within a delegated cap.',
    content: 'Content production and research.',
    technical: 'Technical audits and SEO work.',
    outreach: 'Authority discovery and outreach tracking.',
    sales: 'Intake, scorecards, discovery math and handoff.',
  };

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createOperator({ email, name, role, password });
      setEmail('');
      setName('');
      setPassword('');
      onCreated();
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an operator</DialogTitle>
          <DialogDescription>
            The account is usable as soon as it is created. There is no
            invitation email — hand the password over directly.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <FormError error={error} idPrefix="new-operator-" />

          <div className="space-y-2">
            <Label htmlFor="new-operator-email">
              Email <span className="text-muted-foreground">(required)</span>
            </Label>
            <Input
              id="new-operator-email"
              type="email"
              required
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-operator-name">
              Full name <span className="text-muted-foreground">(required)</span>
            </Label>
            <Input
              id="new-operator-name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-operator-role">
              Role <span className="text-muted-foreground">(required)</span>
            </Label>
            <Select value={role} onValueChange={(value) => setRole(value as OperatorRole)}>
              <SelectTrigger id="new-operator-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-meta text-muted-foreground">{roleDescriptions[role] ?? ''}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-operator-password">
              Temporary password <span className="text-muted-foreground">(required)</span>
            </Label>
            <Input
              id="new-operator-password"
              type="password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {/* Requirement stated in text, never by colour alone (§3.4). */}
            <p className="text-meta text-muted-foreground">
              At least {PASSWORD_MIN_LENGTH} characters. Displayed once here and
              never returned by a later read, so record it before saving.
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create operator'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditOperatorDialog({
  operator,
  open,
  onOpenChange,
  roles,
  isLastAdmin,
  onSaved,
}: {
  operator: SafeUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: OperatorRole[];
  isLastAdmin: boolean;
  onSaved: () => void;
}) {
  const [name, setName] = useState(operator.name);
  const [role, setRole] = useState<OperatorRole>(operator.role);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await updateOperator(operator.id, { name, role });
      onSaved();
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {operator.name}</DialogTitle>
          <DialogDescription>
            Changing the role takes effect on the operator&rsquo;s next request.
            Already-issued access tokens are not revoked by a role change.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <FormError error={error} idPrefix={`edit-operator-${operator.id}-`} />

          <div className="space-y-2">
            <Label htmlFor={`edit-operator-${operator.id}-name`}>Full name</Label>
            <Input
              id={`edit-operator-${operator.id}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={`edit-operator-${operator.id}-role`}>Role</Label>
            <Select value={role} onValueChange={(value) => setRole(value as OperatorRole)}>
              <SelectTrigger id={`edit-operator-${operator.id}-role`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((option) => (
                  <SelectItem key={option} value={option} disabled={isLastAdmin && option !== 'admin'}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isLastAdmin ? (
              <p className="text-meta text-muted-foreground">
                This is the only admin. Every other role is disabled here, and the
                server refuses the demotion anyway (409).
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({
  operator,
  open,
  onOpenChange,
  onReset,
}: {
  operator: SafeUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReset: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ sessionsRevoked: number } | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await resetOperatorPassword(operator.id, password);
      setResult({ sessionsRevoked: response.sessionsRevoked });
      setPassword('');
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset the password for {operator.name}</DialogTitle>
          <DialogDescription>
            This signs {operator.name} out of every session immediately. You are
            setting the password yourself — they will not receive an email.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4">
            <Alert>
              <AlertTitle>Password reset</AlertTitle>
              <AlertDescription>
                {operator.name} now signs in with the password you set.{' '}
                {result.sessionsRevoked} active session
                {result.sessionsRevoked === 1 ? ' was' : 's were'} revoked. It is
                not shown again — pass it on now.
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button type="button" onClick={onReset}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <FormError error={error} idPrefix={`reset-${operator.id}-`} />
            <div className="space-y-2">
              <Label htmlFor={`reset-${operator.id}-password`}>
                New password <span className="text-muted-foreground">(required)</span>
              </Label>
              <Input
                id={`reset-${operator.id}-password`}
                type="password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <p className="text-meta text-muted-foreground">
                At least {PASSWORD_MIN_LENGTH} characters.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Resetting…' : 'Reset password'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
