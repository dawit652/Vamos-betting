/**
 * Hand-over between the register and verify pages (and forgot → reset).
 *
 * The registration token proves who chose the password, so it is kept in
 * memory only (never in storage or the URL), as the contract asks. Client-side
 * navigation keeps this module alive; a reload loses it and the verify page
 * asks the player to register again (which replaces the pending sign-up).
 */

export interface PendingRegistration {
  /** E.164, as sent to the API. */
  phone: string;
  registrationToken: string;
  otpSentTo: string;
  otpExpiresAt: string;
  /** Demo mode only: the code, echoed by the API because no SMS is delivered. */
  demoOtp: string | null;
  /** Where to go once verified. */
  next: string;
}

let registration: PendingRegistration | null = null;
let resetPhone: string | null = null;

export function setPendingRegistration(value: PendingRegistration | null): void {
  registration = value;
}

export function getPendingRegistration(): PendingRegistration | null {
  return registration;
}

export function setPendingResetPhone(phone: string | null): void {
  resetPhone = phone;
}

export function getPendingResetPhone(): string | null {
  return resetPhone;
}
