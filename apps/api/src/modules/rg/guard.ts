/**
 * The player-protection guards moved to @vamos/db (src/rg) so the worker can
 * use them too; they throw DomainError, which the error handler renders like
 * AppError. Re-exported here for the API modules.
 */
export {
  assertCanGamble,
  exclusionError,
  getActiveExclusion,
  type ActiveExclusion,
  type ExclusionKind,
} from '@vamos/db';
