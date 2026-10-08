export interface KycVerificationRequest {
  /** Fayda FIN (12 digits) or FAN (16 digits), digits only. */
  idNumber: string;
  fullName: string;
  /** YYYY-MM-DD. */
  dateOfBirth: string;
}

export type KycVerificationResult =
  | { status: 'verified'; verifiedName: string; verifiedDateOfBirth: string; reference: string }
  | { status: 'rejected'; reason: string }
  | { status: 'pending'; reference: string };

export interface KycVerifier {
  /** `mock` in demo mode; e.g. `fayda` for the national ID service. */
  readonly name: string;
  verify(request: KycVerificationRequest): Promise<KycVerificationResult>;
}

/**
 * Deterministic stand-in for the Fayda national ID registry:
 * - an ID ending in `0000` is not found (rejected);
 * - an ID ending in `9999` needs manual review (pending);
 * - anything else is verified with the submitted name and date of birth.
 */
export class MockKycVerifier implements KycVerifier {
  readonly name = 'mock';

  async verify(request: KycVerificationRequest): Promise<KycVerificationResult> {
    const last4 = request.idNumber.slice(-4);
    if (last4 === '0000') {
      return { status: 'rejected', reason: 'ID not found in the Fayda registry (mock)' };
    }
    if (last4 === '9999') {
      return { status: 'pending', reference: `mock-${last4}` };
    }
    return {
      status: 'verified',
      verifiedName: request.fullName,
      verifiedDateOfBirth: request.dateOfBirth,
      reference: `mock-${last4}`,
    };
  }
}
