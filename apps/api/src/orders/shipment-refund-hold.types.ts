import { isRefundAttemptV1Enabled } from './refund-attempt.types';
import { roundMoney, shipmentPaymentTotal } from './settlement-allocation';

export type ReturnRefundDriveName = 'UNCLAIMED' | 'LEGACY' | 'ATTEMPT';
export type ShipmentRefundHoldStatusName =
  | 'RESERVED'
  | 'CONSUMED'
  | 'RELEASED';
export type LegacyStripeOutcomeName =
  | 'SUCCESS_PENDING_FINALIZE'
  | 'FAILED_TERMINAL';

/** Immutable proof frozen at reservation time. Never mutate after hold create. */
export type ShipmentRefundHoldProof = {
  version: 1;
  paymentMerchandise: number;
  paymentDelivery: number;
  paymentTax: number;
  merchandise: number;
  deliveryFee: number;
  merchandiseTax: number;
  deliveryTax: number;
  returnedMerchandise: number;
  includeDelivery: boolean;
  siblingLiveLineRule: 'no_other_live_sibling_same_supplier';
  siblingHadLiveLine: boolean;
  shipmentPaymentTotal: number;
  refundedAmountBefore: number;
  reservedHoldTotalBefore: number;
  calculatedRefundAmount: number;
  calculatedRefundAmountCents: number;
  currency: string;
  supplierId: string;
  orderShipmentId: string;
  calculation: 'refundPaymentForSupplierAction';
};

export type LegacyStripeEvidenceSourceName = 'FRESH_CREATE' | 'RECOVERY_LIST';

export type LegacyStripeEvidenceClassificationName =
  | 'SUCCEEDED'
  | 'PENDING'
  | 'REQUIRES_ACTION'
  | 'FAILED'
  | 'CANCELED'
  | 'UNKNOWN'
  | 'UNRESOLVED_ERROR'
  | 'LATE_SUCCESS_AFTER_RELEASED';

/** Classify a Stripe refund.status for LEGACY evidence + outcome gates. */
export function classifyLegacyStripeRefundStatus(
  status: string | null | undefined,
): LegacyStripeEvidenceClassificationName {
  const normalized = (status ?? '').trim().toLowerCase();
  if (normalized === 'succeeded') return 'SUCCEEDED';
  if (normalized === 'pending') return 'PENDING';
  if (normalized === 'requires_action') return 'REQUIRES_ACTION';
  if (normalized === 'failed') return 'FAILED';
  if (normalized === 'canceled' || normalized === 'cancelled') return 'CANCELED';
  return 'UNKNOWN';
}

export class ShipmentRefundHoldError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ShipmentRefundHoldError';
    this.code = code;
  }
}

/**
 * Flag controls initial ownership only.
 * test/live + flag → ATTEMPT; otherwise LEGACY (including COD/Lipa/demo).
 */
export function selectReturnRefundDrive(params: {
  paymentMode: string;
  env?: NodeJS.ProcessEnv;
}): 'ATTEMPT' | 'LEGACY' {
  const enabled = isRefundAttemptV1Enabled(params.env);
  if (!enabled) return 'LEGACY';
  const mode = params.paymentMode.trim().toLowerCase();
  if (mode === 'test' || mode === 'live') return 'ATTEMPT';
  return 'LEGACY';
}

export function isCardPaymentMode(paymentMode: string): boolean {
  const mode = paymentMode.trim().toLowerCase();
  return mode === 'test' || mode === 'live';
}

/**
 * Reject unsupported sub-cent amounts before any financial write.
 * 0.001 / 0.004 must fail; exact hundredths (including 0.00) are accepted.
 */
export function assertExactHundredthsAmount(amount: number): number {
  if (!Number.isFinite(amount)) {
    throw new ShipmentRefundHoldError(
      'amount_not_finite',
      'Refund amount must be a finite number',
    );
  }
  const scaled = amount * 100;
  const nearest = Math.round(scaled);
  if (Math.abs(scaled - nearest) > 1e-8) {
    throw new ShipmentRefundHoldError(
      'amount_sub_cent',
      `Refund amount ${amount} has unsupported sub-cent precision`,
    );
  }
  return roundMoney(amount);
}

export function amountToCentsExact(amount: number): number {
  const exact = assertExactHundredthsAmount(amount);
  return Math.round(exact * 100);
}

export function availableShipmentRefundCapacity(params: {
  paymentMerchandise: number;
  paymentDelivery: number;
  paymentTax: number;
  refundedAmount: number;
  reservedHoldTotal: number;
}): number {
  const total = shipmentPaymentTotal(params);
  return roundMoney(
    total - Number(params.refundedAmount) - Number(params.reservedHoldTotal),
  );
}

/** Historical ISSUED remains completed even when refundDrive is still UNCLAIMED. */
export function isHistoricalIssuedComplete(params: {
  refundStatus: string;
  refundDrive: string;
}): boolean {
  return (
    params.refundStatus === 'ISSUED' &&
    (params.refundDrive === 'UNCLAIMED' ||
      params.refundDrive === 'LEGACY' ||
      params.refundDrive === 'ATTEMPT')
  );
}
