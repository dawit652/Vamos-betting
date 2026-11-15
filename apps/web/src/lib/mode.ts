/**
 * Whether this build of the player site is a demo (play money). `NEXT_PUBLIC_OPERATING_MODE` is inlined at
 * build time (the production Dockerfile passes it); only `licensed` is real money, anything else, including
 * unset, is a demo so that a missing setting never hides the play-money notices.
 */
export function isDemoMode(mode: string | undefined): boolean {
  return mode !== 'licensed';
}

export const IS_DEMO: boolean = isDemoMode(process.env.NEXT_PUBLIC_OPERATING_MODE);
