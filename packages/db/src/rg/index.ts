/**
 * Responsible-gambling guards shared by the API and the worker. They throw
 * DomainError (403 / 404 / 422) with the same codes and details the API
 * returns to players.
 */
export {
  assertCanGamble,
  exclusionError,
  getActiveExclusion,
  type ActiveExclusion,
  type ExclusionKind,
} from './exclusions';
export {
  assertDepositAllowed,
  assertStakeAllowed,
  getActiveLimits,
  getLimitStates,
  LIMIT_SLOTS,
  limitSlotKey,
  limitSlotOf,
  loadLimitRows,
  lockUser,
  resolveLimitRows,
  resolveLimitSlot,
  ROLLING_PERIODS,
  ROLLING_WINDOW_MS,
  shapeLimits,
  type ActiveLimits,
  type LimitKind,
  type LimitPeriod,
  type LimitRow,
  type LimitShape,
  type LimitSlot,
  type LimitSlotState,
  type RollingPeriod,
} from './limits';
