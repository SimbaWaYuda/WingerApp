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

export type CommissionMoneyRow = {
  status: string;
  isDemo: boolean;
  amount: number;
  itemStatus: string;
  paymentStatus: string;
  paymentMode: string;
  supplierId: string;
  collectedSupplierIds: string[];
};

/** Cash is confirmed for this supplier, or the order is a legacy paid COD with no collection rows. */
export function paymentConfirmedForLine(
  row: Pick<
    CommissionMoneyRow,
    'paymentMode' | 'paymentStatus' | 'supplierId' | 'collectedSupplierIds'
  >,
): boolean {
  if (row.paymentMode === 'cod') {
    if (row.collectedSupplierIds.includes(row.supplierId)) return true;
    return (
      row.paymentStatus === 'PAID' && row.collectedSupplierIds.length === 0
    );
  }
  return row.paymentStatus === 'PAID';
}

/** Settleable reporting requires a paid, delivered, non-demo line. */
export function isReportableSettleable(row: CommissionMoneyRow): boolean {
  return (
    row.isDemo === false &&
    row.status === 'SETTLEABLE' &&
    row.itemStatus === 'DELIVERED' &&
    paymentConfirmedForLine(row)
  );
}

/** Earned revenue is recognised or validly settleable. Pending COD is not earned. */
export function countsAsEarnedRevenue(row: CommissionMoneyRow): boolean {
  if (row.isDemo || row.status === 'PENDING' || row.status === 'CLAWED_BACK') {
    return false;
  }
  if (row.status === 'RECOGNIZED') return true;
  if (row.status === 'SETTLEABLE') return isReportableSettleable(row);
  return false;
}

export function sumCommissionBuckets(rows: CommissionMoneyRow[]) {
  let pending = 0;
  let recognized = 0;
  let settleable = 0;
  let reversed = 0;
  let earned = 0;
  for (const row of rows) {
    if (row.isDemo) continue;
    if (row.status === 'CLAWED_BACK') {
      reversed += row.amount;
      continue;
    }
    if (row.status === 'PENDING') pending += row.amount;
    if (row.status === 'RECOGNIZED') recognized += row.amount;
    if (isReportableSettleable(row)) settleable += row.amount;
    if (countsAsEarnedRevenue(row)) earned += row.amount;
  }
  return {
    pendingCommission: roundMoney(pending),
    recognizedCommission: roundMoney(recognized),
    settleableCommission: roundMoney(settleable),
    reversedCommission: roundMoney(reversed),
    earnedRevenue: roundMoney(earned),
  };
}

export function commissionReportRow(row: {
  status: string;
  isDemo: boolean;
  commissionAmount: unknown;
  orderItem?: {
    status?: string;
    supplierId?: string;
    order?: {
      paymentStatus?: string;
      paymentMode?: string;
      cashCollections?: Array<{ supplierId: string }>;
    } | null;
  } | null;
}): CommissionMoneyRow {
  const item = row.orderItem;
  const order = item?.order;
  return {
    status: row.status,
    isDemo: Boolean(row.isDemo),
    amount: roundMoney(Number(row.commissionAmount)),
    itemStatus: item?.status ?? '',
    paymentStatus: order?.paymentStatus ?? '',
    paymentMode: order?.paymentMode ?? '',
    supplierId: item?.supplierId ?? '',
    collectedSupplierIds: (order?.cashCollections ?? []).map(
      (collection) => collection.supplierId,
    ),
  };
}

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
