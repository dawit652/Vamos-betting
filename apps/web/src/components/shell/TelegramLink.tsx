/**
 * "Join us on Telegram": opens the owner's bot or channel (lib/telegram.ts) in a new tab.
 * No hooks, so server components (footer, side column) and the phone panel share it.
 */
export function TelegramLink({
  href,
  label,
  className = '',
}: {
  href: string;
  label: string;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-2 font-semibold ${className}`}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
        <path d="M21.9 4.3 18.7 19.5c-.2 1-.9 1.3-1.7.8l-4.8-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2L6.5 13.3 1.8 11.8c-1-.3-1-1 .2-1.5L20.4 3.2c.9-.3 1.6.2 1.5 1.1z" />
      </svg>
      {label}
    </a>
  );
}
