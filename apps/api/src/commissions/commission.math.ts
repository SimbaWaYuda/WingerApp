/** Pure commission helpers — unit-tested, no I/O. */

export function roundMoney(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

export function assertValidRatePercent(rate: number): void {
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new Error('Commission rate must be between 0 and 100');
  }
}

/** Commission base = discounted selling line total (excl. tax & delivery). */
export function commissionBaseFromLine(
  unitPrice: number,
  quantity: number,
): number {
  return roundMoney(unitPrice * quantity);
}

export function computeCommissionAmount(
  commissionBase: number,
  ratePercent: number,
): number {
  assertValidRatePercent(ratePercent);
  return roundMoney((commissionBase * ratePercent) / 100);
}

export type SnapshotInput = {
  unitPrice: number;
  quantity: number;
  ratePercent: number;
};

export type SnapshotValues = {
  commissionBase: number;
  ratePercent: number;
  commissionAmount: number;
};

export function buildSnapshotValues(input: SnapshotInput): SnapshotValues {
  const commissionBase = commissionBaseFromLine(
    input.unitPrice,
    input.quantity,
  );
  const ratePercent = roundMoney(input.ratePercent);
  assertValidRatePercent(ratePercent);
  return {
    commissionBase,
    ratePercent,
    commissionAmount: computeCommissionAmount(commissionBase, ratePercent),
  };
}
