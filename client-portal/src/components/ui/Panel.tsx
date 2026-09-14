import { cn } from '@/lib/utils';

export function Panel({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('rounded-r3 border border-border bg-bg-raised p-4 shadow-e1', className)}>
      {children}
    </div>
  );
}

export function PanelHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-title font-medium">{title}</h2>
      {action}
    </div>
  );
}
