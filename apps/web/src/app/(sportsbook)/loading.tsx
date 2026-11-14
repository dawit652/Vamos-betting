/** Instant placeholder while a sportsbook page renders on the server (no JavaScript). */
export default function Loading() {
  return (
    <div aria-busy="true" className="mx-auto max-w-2xl animate-pulse space-y-3 px-3 pt-3">
      <div className="h-8 w-2/3 rounded-full bg-surface" />
      <div className="h-40 rounded-2xl bg-surface" />
      <div className="panel">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="list-row space-y-2">
            <div className="h-3 w-1/3 rounded-full bg-raised" />
            <div className="flex gap-2">
              <div className="h-10 flex-1 rounded-lg bg-raised/60" />
              <div className="h-10 w-[10.75rem] rounded-lg bg-raised" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
