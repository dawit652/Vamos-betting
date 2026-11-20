/**
 * "Reset at a shop" (Forgot PIN without SMS or Telegram) is offered while the API's switch
 * CASHIER_PIN_RESET is on. A run-time setting like TELEGRAM_PUBLIC_URL: server components read it
 * per request, so switching it needs no new image.
 */
export function shopPinResetEnabled(): boolean {
  return process.env.CASHIER_PIN_RESET === 'on';
}
