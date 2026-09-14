'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRequireAuth } from '@/lib/useRequireAuth';
import { getPortalReport } from '@/lib/endpoints';
import { TopBar } from '@/components/ui/TopBar';
import { ReportView } from '@/components/report/ReportView';
import type { ReportData } from '@/types/api';

export default function PortalReportPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const user = useRequireAuth('client');
  const [report, setReport] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPortalReport(slug)
      .then(setReport)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load report'));
  }, [slug]);

  return (
    <div className="min-h-screen">
      <TopBar user={user} label="portal" />
      <main className="mx-auto max-w-3xl space-y-4 px-5 py-6">
        <Link href="/portal/reports" className="text-caption text-faint hover:text-dim">
          ← Reports
        </Link>
        {error && <p className="text-body text-red">{error}</p>}
        {!report && !error && <div className="h-64 skeleton" />}
        {report && <ReportView report={report} />}
      </main>
    </div>
  );
}
