'use client';

/**
 * /v3 — Overview. A real dashboard: a stat row, then a card grid (project
 * summary, suggested queries, presence, audits), then agents + the Cailyx
 * Assistant. Replaces /v2's fixed three-band canvas (a Flywheel welded to
 * the left wall, a Context drawer welded to the right wall, two tiles
 * floating between) — normal document flow instead of wall-mounted pieces.
 *
 * @module app/v3/page
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useV3 } from './_lib/SessionContext';
import { useOverview } from './_lib/useOverview';
import { PageHeader } from './_components/PageHeader';
import { Card, CardHeader, StatCard } from './_components/Card';
import { ProjectSummary } from './_components/ProjectSummary';
import { SuggestedQueries } from './_components/SuggestedQueries';
import { AgentsFeed } from './_components/AgentsFeed';
import { Audits } from './_components/Audits';
import { DigitalPresence } from './_components/DigitalPresence';
import { ChatBot, type ChatSeed } from './_components/ChatBot';
import { ErrorBoundary } from './_components/ErrorBoundary';
import { BoltIcon } from './_components/icons';

export default function OverviewPage() {
  const { session: c, notify, integrations, setPanel } = useV3();
  const { wheel, wheelLoading, querySets } = useOverview(c.activeId);
  const router = useRouter();

  const [seed, setSeed] = useState<ChatSeed | null>(null);
  const [agentKey, setAgentKey] = useState<string | null>(null);

  const handOff = (kind: ChatSeed['kind'], text: string) =>
    setSeed((s) => ({ id: (s?.id ?? 0) + 1, kind, text }));

  const stats = c.project?.stats;
  const runningAgents = c.agents?.agents.filter((a) => a.status === 'running').length ?? 0;
  const attentionAgents = c.agents?.agents.filter((a) => a.status === 'attention').length ?? 0;

  return (
    <div className="v3-section overflow-y-auto">
      <PageHeader title="Overview" description={c.project ? c.project.domain : 'Select a project to get started'} />

      {!c.activeId ? (
        <div className="p-6">
          <Card className="p-8 text-center">
            <p className="text-body text-faint">No project selected yet. Create one from the sidebar or topbar.</p>
          </Card>
        </div>
      ) : (
        <div className="space-y-5 p-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Open gaps" value={stats?.gaps ?? '—'} tone={stats && stats.gaps > 0 ? 'warn' : 'default'} />
            <StatCard label="Technical audits" value={stats?.technicalAudits ?? '—'} />
            <StatCard label="Reports" value={stats?.reports ?? '—'} />
            <StatCard
              label="Agents active"
              value={runningAgents}
              hint={attentionAgents > 0 ? `${attentionAgents} need attention` : undefined}
              tone={attentionAgents > 0 ? 'warn' : 'default'}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ErrorBoundary label="Project summary">
              <ProjectSummary project={c.project} onSave={c.saveProject} />
            </ErrorBoundary>
            <ErrorBoundary label="Suggested queries">
              <SuggestedQueries
                wheel={wheel}
                loading={c.booting || wheelLoading || c.projectPending}
                onPick={(q) => handOff('query', q)}
              />
            </ErrorBoundary>
            <ErrorBoundary label="Digital presence">
              <DigitalPresence
                key={c.activeId}
                projectId={c.activeId}
                domain={c.project?.domain ?? null}
                booting={c.booting}
                onNotify={notify}
                onExpand={() => router.push('/v3/presence')}
              />
            </ErrorBoundary>
            <ErrorBoundary label="Audits">
              <Audits
                key={c.activeId}
                projectId={c.activeId}
                domain={c.project?.domain ?? null}
                booting={c.booting}
                onNotify={notify}
                onExpand={(tab) =>
                  router.push(
                    tab === 'competitors' ? '/v3/rivals' : tab === 'keywords' ? '/v3/keywords' : `/v3/audits/${tab}`,
                  )
                }
              />
            </ErrorBoundary>
          </div>

          <Card>
            <CardHeader title="Agents" icon={<BoltIcon className="h-3.5 w-3.5" />} />
            <div className="grid grid-cols-1 gap-0 lg:grid-cols-2 lg:divide-x lg:divide-border">
              <div className="min-h-0 p-4">
                <ErrorBoundary label="The agents feed">
                  <AgentsFeed
                    data={c.agents}
                    loading={c.booting || c.agentsLoading || c.projectPending}
                    projectId={c.activeId}
                    runCtx={{ integrations, querySets }}
                    onOpenGap={() => router.push('/v3/rivals')}
                    selectedKey={agentKey}
                    onSelect={setAgentKey}
                    onRefresh={c.refreshAgents}
                    onAsk={(key) => handOff('agent', key)}
                    onRan={(key, error) => {
                      if (error) {
                        notify(error, 'warn');
                        return;
                      }
                      void c.refreshAgentsAnd((next) => {
                        const a = next.agents.find((x) => x.key === key);
                        notify(a ? `${a.name}: ${a.headline}` : 'run complete');
                      });
                    }}
                  />
                </ErrorBoundary>
              </div>
              <div className="min-h-[24rem] p-4">
                <ErrorBoundary label="Cailyx Assistant">
                  <ChatBot
                    project={c.project}
                    agents={c.agents}
                    integrations={integrations}
                    seed={seed}
                    onOpenConnections={() => setPanel('connections')}
                  />
                </ErrorBoundary>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
