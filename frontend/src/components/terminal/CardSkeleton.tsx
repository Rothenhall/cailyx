/**
 * CardSkeleton — shimmer placeholder shown inside a card while its project data
 * loads (project switch, new project, first paint). Keeps the layout stable so
 * cards never blank out or flash stale content.
 *
 * @module components/terminal/CardSkeleton
 */

type Shape = 'list' | 'profile' | 'chart' | 'feed';

function Bar({ w = '100%', h = 10 }: { w?: string; h?: number }) {
  return <div className="skeleton" style={{ width: w, height: h }} />;
}

export function CardSkeleton({ shape = 'list', label }: { shape?: Shape; label?: string }) {
  return (
    <div className="flex h-full flex-col gap-3 p-3" aria-busy="true" aria-live="polite">
      {label && <p className="text-[10px] uppercase tracking-widest text-faint">{label}</p>}

      {shape === 'chart' && (
        <div className="flex flex-col items-center gap-3 py-4">
          <div className="skeleton" style={{ width: 180, height: 180, borderRadius: '9999px' }} />
          <Bar w="60%" />
          <Bar w="45%" />
        </div>
      )}

      {shape === 'profile' && (
        <>
          <div className="flex items-center gap-2">
            <div className="skeleton" style={{ width: 28, height: 28, borderRadius: 6 }} />
            <div className="flex-1 space-y-1.5">
              <Bar w="55%" />
              <Bar w="35%" h={8} />
            </div>
          </div>
          <Bar h={64} />
          <div className="space-y-2 pt-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <Bar key={i} w={`${80 - i * 6}%`} />
            ))}
          </div>
        </>
      )}

      {(shape === 'list' || shape === 'feed') && (
        <div className="space-y-2.5">
          {Array.from({ length: shape === 'feed' ? 8 : 5 }).map((_, i) => (
            <div key={i} className="flex items-start gap-2">
              {shape === 'feed' && <div className="skeleton mt-0.5" style={{ width: 12, height: 12, borderRadius: 3 }} />}
              <div className="flex-1 space-y-1.5">
                <Bar w={`${72 - (i % 3) * 12}%`} />
                {i % 2 === 0 && <Bar w="90%" h={8} />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
