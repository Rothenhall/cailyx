'use client';

import { use } from 'react';
import Link from 'next/link';
import { useRequireAuth } from '@/lib/useRequireAuth';
import { useClientDetail } from '../../_lib/useClientDetail';
import { TopBar } from '@/components/ui/TopBar';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import { ClientInfoPanel } from '../../_components/ClientInfoPanel';
import { ProjectsPanel } from '../../_components/ProjectsPanel';
import { CreateLoginPanel } from '../../_components/CreateLoginPanel';
import { MessageThread } from '@/components/messages/MessageThread';
import { useToast } from '@/components/ui/Toast';

export default function ClientDetailPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = use(params);
  const user = useRequireAuth('operator');
  const { client, messages, error, updateClient, addProject, createLogin, sendMessage } = useClientDetail(clientId);
  const { push } = useToast();

  return (
    <div className="min-h-screen">
      <TopBar user={user} label="admin" />
      <main className="mx-auto max-w-4xl space-y-4 px-5 py-6">
        <Link href="/admin" className="text-caption text-faint hover:text-dim">
          ← All clients
        </Link>

        {error && <p className="text-body text-red">{error}</p>}
        {!client && !error && <div className="h-32 skeleton" />}

        {client && (
          <>
            <ClientInfoPanel client={client} onUpdate={updateClient} />
            <ProjectsPanel clientId={clientId} projects={client.projects} onAdd={addProject} />
            <CreateLoginPanel onCreate={createLogin} />
            <Panel>
              <PanelHeader title="Messages" />
              <MessageThread
                messages={messages}
                selfType="operator"
                onSend={async (body) => {
                  try {
                    await sendMessage(body);
                  } catch (err) {
                    push(err instanceof Error ? err.message : 'Failed to send message', 'error');
                  }
                }}
              />
            </Panel>
          </>
        )}
      </main>
    </div>
  );
}
