import {
  PaymentArrangementPreference,
  SupplierPaymentProfileStatus,
} from '@prisma/client';

export type PaymentProfileLike = {
  preference: PaymentArrangementPreference | string;
  status: SupplierPaymentProfileStatus | string;
};

/**
 * Checkout arrangement for a supplier. Supplier-direct only when an approved
 * profile prefers it; otherwise Winger-managed.
 */
export function effectivePaymentArrangement(
  profile: PaymentProfileLike | null | undefined,
): PaymentArrangementPreference {
  if (
    profile &&
    profile.status === SupplierPaymentProfileStatus.APPROVED &&
    profile.preference === PaymentArrangementPreference.SUPPLIER_DIRECT
  ) {
    return PaymentArrangementPreference.SUPPLIER_DIRECT;
  }
  return PaymentArrangementPreference.WINGER_MANAGED;
}

export function normalizeLipaOrTillNumber(value: string): string {
  return value.replace(/\s+/g, '').trim().toUpperCase();
}

export function isValidLipaOrTillNumber(value: string): boolean {
  const normalized = normalizeLipaOrTillNumber(value);
  // Tanzania Lipa/Till numbers are typically 6–20 alphanumeric (Selcom SELCOMPAY).
  return /^[A-Z0-9]{6,20}$/.test(normalized);
}
