import type { SecretReader } from '@vamos/scraper';

/**
 * The scraper's own environment as a secret reader (docs/scraper.md 6.7). The fetcher asks for a
 * variable by name when it needs the key; nothing else reads SCRAPER_SECRET_* and nothing keeps
 * the values (they are not in the config object, the context or the database).
 */
export function envSecretReader(env: NodeJS.ProcessEnv = process.env): SecretReader {
  return (name) => env[name];
}

const SECRET_PROBLEMS: Record<string, string> = {
  secret_missing: 'is not set or is empty in the scraper environment; nothing was requested',
  secret_invalid:
    'does not hold a usable API key (printable ASCII, no line breaks); nothing was requested',
  secret_echoed: 'was found in the response; the response was dropped (not archived, not parsed)',
};

/** What went wrong with a source's API key, naming the variable (never its value). */
export function secretProblemMessage(reason: string, name: string | undefined): string {
  const what = name === undefined ? 'the API key variable' : `the variable ${name}`;
  return `${what} ${SECRET_PROBLEMS[reason] ?? 'cannot be used'}`;
}
