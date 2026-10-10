/** Instant placeholder while a sportsbook page renders on the server (no JavaScript). */
export default function Loading() {
  return (
    <div aria-busy="true" className="animate-pulse">
      <div className="h-10 border-b border-line bg-surface" />
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="list-row space-y-2">
          <div className="h-3 w-1/3 rounded-sm bg-line" />
          <div className="flex gap-2">
            <div className="h-9 flex-1 rounded-sm bg-line/60" />
            <div className="h-9 w-[11.5rem] rounded-sm bg-line" />
          </div>
        </div>
      ))}
    </div>
  );
}
