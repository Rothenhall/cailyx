'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/patterns/PageHeader';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api';
import { createClient } from '@/services/clients';

/**
 * OP03 — Add client.
 *
 * design_plan.md §4.2 specifies: "Client name, contact name/email, lead,
 * internal notes; separate create-project step."
 *
 * The deliberate shape here is that this form creates **only a client**. It
 * does not also create a project or start a pipeline. §5.3 separates the two:
 * a client is a commercial relationship, a project is a domain being measured,
 * and conflating them in one submit is what produces a "client" with a
 * half-configured domain attached when the second half of the form fails.
 *
 * §11.2 case 2 also applies: creation is not safely repeatable. If this
 * succeeds but a later step fails, the operator is sent to the client page
 * rather than invited to submit again — a blind retry on a create is how
 * duplicates happen.
 */
export default function AddClientPage() {
  const router = useRouter();

  const [name, setName] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [notes, setNotes] = useState('');

  const [error, setError] = useState<{ message: string; fields?: Record<string, string[]> } | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);
  /** Set once the client exists, so a failure after creation cannot re-create it. */
  const [createdId, setCreatedId] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || createdId) return;

    if (!name.trim()) {
      setError({ message: 'Enter the client name.', fields: { name: ['Client name is required.'] } });
      return;
    }

    setError(null);
    setSubmitting(true);

    try {
      const created = await createClient({
        name: name.trim(),
        contactName: contactName.trim() || undefined,
        contactEmail: contactEmail.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      setCreatedId(created.id);
      router.push(`/ops/clients/${created.id}`);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? { message: caught.message, fields: caught.fieldErrors }
          : { message: 'Could not create the client. Nothing was saved.' },
      );
    } finally {
      setSubmitting(false);
    }
  }

  // Once the record exists, the only honest action is to go and look at it.
  if (createdId) {
    return (
      <div className="max-w-2xl space-y-6">
        <PageHeader
          breadcrumbs={[{ label: 'Clients', href: '/ops/clients' }]}
          title="Client created"
        />
        <Alert>
          <AlertDescription className="space-y-3">
            <p>
              The client record exists now. Do not submit this form again — that
              would create a second, duplicate client.
            </p>
            <Button size="sm" onClick={() => router.push(`/ops/clients/${createdId}`)}>
              Open the client
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader
        breadcrumbs={[{ label: 'Clients', href: '/ops/clients' }]}
        title="Add client"
        context="Creates the client record only. Projects and setup come next."
      />

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}

      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Client</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field
              id="name"
              label="Client name"
              required
              value={name}
              onChange={setName}
              errors={error?.fields?.name}
              disabled={submitting}
              autoFocus
            />
            <Field
              id="contactName"
              label="Contact name"
              value={contactName}
              onChange={setContactName}
              errors={error?.fields?.contactName}
              disabled={submitting}
            />
            <Field
              id="contactEmail"
              label="Contact email"
              type="email"
              value={contactEmail}
              onChange={setContactEmail}
              errors={error?.fields?.contactEmail}
              disabled={submitting}
              help="Used for report delivery and invitations. It does not create a login by itself."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Internal notes</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea
              id="notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              disabled={submitting}
              rows={4}
              placeholder="Anything the delivery team should know. Not visible to the client."
            />
            <p className="mt-2 text-meta text-muted-foreground">
              Internal only — never shown in the client portal.
            </p>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={submitting || !name.trim()}>
            {submitting ? 'Creating…' : 'Create client'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => router.push('/ops/clients')}
            disabled={submitting}
          >
            Cancel
          </Button>
        </div>
      </form>
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
  autoFocus,
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
  autoFocus?: boolean;
}) {
  const invalid = Boolean(errors?.length);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {/* §3.4 — required is stated in text, never by color alone. */}
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
        autoFocus={autoFocus}
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
