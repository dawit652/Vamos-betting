/**
 * Points down; turns up while its <details class="group"> is open. Plain markup, so
 * server components (MatchList) and client islands (MarketSections) can both use it.
 */
export function Chevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="flex-none text-muted transition-transform group-open:rotate-180"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
