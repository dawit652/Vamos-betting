/** `demo`: play money, mock providers. `licensed`: real money (needs an ELS licence). */
export type OperatingMode = 'demo' | 'licensed';

/** The mode in a GET /health body, or null when the body does not state one. */
export function modeFromHealth(body: unknown): OperatingMode | null {
  if (typeof body !== 'object' || body === null) return null;
  const mode = (body as { mode?: unknown }).mode;
  return mode === 'demo' || mode === 'licensed' ? mode : null;
}
