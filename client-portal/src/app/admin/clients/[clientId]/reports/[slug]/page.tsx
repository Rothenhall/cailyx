'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useRequireAuth } from '@/lib/useRequireAuth';
import { getReport } from '@/lib/endpoints';
import { TopBar } from '@/components/ui/TopBar';
import { ReportView } from '@/components/report/ReportView';
import type { ReportData } from '@/types/api';

export default function AdminReportPage({
  params,
}: {
  params: Promise<{ clientId: string; slug: string }>;
}) {
  const { clientId, slug } = use(params);
  const searchParams = useSearchParams();
  const projectId = searchParams.get('projectId');
  const user = useRequireAuth('operator');
  const [report, setReport] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) {
      setError('Missing projectId — open this report from the client\'s project list.');
      return;
    }
    getReport(projectId, slug)
      .then(setReport)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load report'));
  }, [projectId, slug]);

  return (
    <div className="min-h-screen">
      <TopBar user={user} label="admin" />
      <main className="mx-auto max-w-3xl space-y-4 px-5 py-6">
        <Link href={`/admin/clients/${clientId}`} className="text-caption text-faint hover:text-dim">
          ← Client
        </Link>
        {error && <p className="text-body text-red">{error}</p>}
        {!report && !error && <div className="h-64 skeleton" />}
        {report && <ReportView report={report} />}
      </main>
    </div>
  );
}
