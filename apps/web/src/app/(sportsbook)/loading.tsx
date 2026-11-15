/** Instant placeholder while a sportsbook page renders on the server (no JavaScript). */
export default function Loading() {
  return (
    <div aria-busy="true" className="mx-auto max-w-2xl animate-pulse space-y-3 px-3 pt-3">
      <div className="h-10 rounded-full bg-surface" />
      <div className="h-40 rounded-2xl bg-surface" />
      <div className="h-96 rounded-2xl bg-surface" />
    </div>
  );
}
