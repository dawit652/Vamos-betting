/**
 * @vamos/core – pure domain logic shared by the API, worker and front ends.
 * No I/O, no dependencies. Money is BigInt santim (1 ETB = 100 santim) and
 * odds are integer "milli" (1.85 → 1850).
 */
export const CURRENCY = 'ETB' as const;
export const SANTIM_PER_BIRR = 100n;
