/** Pure commission-ledger decisions. Amounts stay on OrderItemCommission. */

export function roundMoney(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

/** Capacity left after offsets and application rows that are still active. */
export function remainingCredit(
  amount: number,
  offsets: number,
  activeApplied: number,
): number {
  return roundMoney(amount - offsets - activeApplied);
}

/**
 * A Lipa order becomes paid only when it is a Lipa order and every live
 * supplier has verified customer-payment evidence. Card and COD never qualify.
 */
export function lipaSuppliersReadyForPayment(input: {
  paymentMode: string;
  liveSupplierIds: string[];
  verifiedSupplierIds: string[];
}): boolean {
  if (input.paymentMode !== 'lipa') return false;
  if (input.liveSupplierIds.length === 0) return false;
  const verified = new Set(input.verifiedSupplierIds);
  return input.liveSupplierIds.every((id) => verified.has(id));
}

export function normalizePaymentReference(raw: string): string {
  return raw.replace(/\s+/g, '').trim().toUpperCase();
}

export function requireNonEmptyToken(value: string, label: string): string {
  const token = value.trim();
  if (!token) {
    throw new Error(`${label} is required`);
  }
  return token;
}

export type PayableSlice = {
  id: string;
  settleableAt: string;
  remaining: number;
};

export type AllocationSlice = {
  snapshotId: string;
  amount: number;
};

/** Oldest settleableAt, then id. Stops when the money or the balance runs out. */
export function allocateOldestFirst(
  lines: PayableSlice[],
  amount: number,
): AllocationSlice[] {
  const budget = roundMoney(amount);
  if (!(budget > 0)) return [];
  const ordered = [...lines]
    .filter((line) => line.remaining > 0)
    .sort((a, b) => {
      const time = a.settleableAt.localeCompare(b.settleableAt);
      if (time !== 0) return time;
      return a.id.localeCompare(b.id);
    });
  const slices: AllocationSlice[] = [];
  let left = budget;
  for (const line of ordered) {
    if (!(left > 0)) break;
    const take = roundMoney(Math.min(left, line.remaining));
    if (!(take > 0)) continue;
    slices.push({ snapshotId: line.id, amount: take });
    left = roundMoney(left - take);
  }
  return slices;
}

export type SourceCapacity = {
  sourceId: string;
  createdAt: string;
  remaining: number;
};

export type SourceSlice = {
  sourceId: string;
  amount: number;
};

/** Oldest credit source first. The slices must sum to the requested amount or the caller rolls back. */
export function consumeCreditSources(
  sources: SourceCapacity[],
  amount: number,
): SourceSlice[] {
  const budget = roundMoney(amount);
  if (!(budget > 0)) return [];
  const ordered = [...sources]
    .filter((source) => source.remaining > 0)
    .sort((a, b) => {
      const time = a.createdAt.localeCompare(b.createdAt);
      if (time !== 0) return time;
      return a.sourceId.localeCompare(b.sourceId);
    });
  const slices: SourceSlice[] = [];
  let left = budget;
  for (const source of ordered) {
    if (!(left > 0)) break;
    const take = roundMoney(Math.min(left, source.remaining));
    if (!(take > 0)) continue;
    slices.push({ sourceId: source.sourceId, amount: take });
    left = roundMoney(left - take);
  }
  if (left > 0) {
    throw new Error('Credit sources do not cover the application');
  }
  return slices;
}

export type ActiveApplicationSource = {
  id: string;
  creditSourceId: string;
  active: number;
  createdAt: string;
};

export type ClawbackPlan = {
  applicationSourceReversals: { applicationSourceId: string; amount: number; reversalKey: string }[];
  /** Same dollars as the cash credit, so collected cash no longer includes them. */
  allocationReversals: { allocationId: string; amount: number; reversalKey: string }[];
  cashCredit: {
    sourceEventKey: string;
    amount: number;
    sources: { allocationId: string; amount: number }[];
  } | null;
};

/**
 * Customer refund: reverse credit applications on this snapshot and open a
 * credit only for cash still allocated to it. Does not create a second credit
 * for the restored amount.
 */
/**
 * Slice of the original snapshot for this return. The return that completes
 * the line quantity takes whatever commission is still unrecorded, so the
 * slices sum to the snapshot and never pass it.
 */
export function proportionalCommissionSlice(input: {
  commissionAmount: number;
  lineQuantity: number;
  alreadyReturned: number;
  quantity: number;
  alreadyClawed: number;
}): number {
  if (!Number.isInteger(input.lineQuantity) || input.lineQuantity < 1) {
    throw new Error('Line quantity is required');
  }
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new Error('Return quantity is required');
  }
  if (
    input.alreadyReturned < 0 ||
    input.alreadyReturned + input.quantity > input.lineQuantity
  ) {
    throw new Error('Return quantity exceeds the line');
  }
  const remaining = roundMoney(input.commissionAmount - input.alreadyClawed);
  if (remaining < 0) {
    throw new Error('Clawbacks exceed the snapshot');
  }
  if (input.alreadyReturned + input.quantity === input.lineQuantity) {
    return remaining;
  }
  const share = roundMoney(
    (input.commissionAmount * input.quantity) / input.lineQuantity,
  );
  return roundMoney(Math.min(Math.max(share, 0), remaining));
}

export function netCommissionAmount(
  commissionAmount: number,
  appliedClawbacks: number[],
): number {
  const clawed = appliedClawbacks.reduce((sum, amount) => sum + amount, 0);
  return roundMoney(Math.max(0, commissionAmount - clawed));
}

export type PartialClawbackPlan = {
  applicationSourceReversals: {
    applicationSourceId: string;
    amount: number;
    reversalKey: string;
  }[];
  /** Reduces active collected cash by the same amount that becomes a credit. */
  allocationReversals: {
    allocationId: string;
    amount: number;
    reversalKey: string;
  }[];
  cashCredit: {
    sourceEventKey: string;
    amount: number;
    sources: { allocationId: string; amount: number }[];
  } | null;
};

/**
 * Releases only the settled coverage that no longer belongs on the kept units.
 * Credit applications go first, then cash. Cash that becomes a credit is also
 * reversed on the allocation, so it is not still counted as collected.
 * Unpaid commission produces no credit and no allocation reversal.
 */
export function planPartialClawback(input: {
  eventKey: string;
  retainedAfter: number;
  activeApplicationSources: { id: string; active: number; createdAt: string }[];
  activeCashAllocations: { allocationId: string; amount: number; createdAt: string }[];
}): PartialClawbackPlan {
  const retained = roundMoney(Math.max(0, input.retainedAfter));
  const applications = input.activeApplicationSources
    .filter((row) => row.active > 0)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const allocations = input.activeCashAllocations
    .filter((row) => row.amount > 0)
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) ||
        a.allocationId.localeCompare(b.allocationId),
    );
  const settled = roundMoney(
    applications.reduce((sum, row) => sum + row.active, 0) +
      allocations.reduce((sum, row) => sum + row.amount, 0),
  );
  let excess = roundMoney(Math.max(0, settled - retained));
  const applicationSourceReversals: PartialClawbackPlan['applicationSourceReversals'] =
    [];
  for (const row of applications) {
    if (!(excess > 0)) break;
    const take = roundMoney(Math.min(excess, row.active));
    if (!(take > 0)) continue;
    applicationSourceReversals.push({
      applicationSourceId: row.id,
      amount: take,
      reversalKey: `return-clawback:${input.eventKey}:application-source:${row.id}`,
    });
    excess = roundMoney(excess - take);
  }
  const allocationReversals: PartialClawbackPlan['allocationReversals'] = [];
  const sources: { allocationId: string; amount: number }[] = [];
  for (const row of allocations) {
    if (!(excess > 0)) break;
    const take = roundMoney(Math.min(excess, row.amount));
    if (!(take > 0)) continue;
    allocationReversals.push({
      allocationId: row.allocationId,
      amount: take,
      reversalKey: `return-clawback:${input.eventKey}:allocation:${row.allocationId}`,
    });
    sources.push({ allocationId: row.allocationId, amount: take });
    excess = roundMoney(excess - take);
  }
  const amount = roundMoney(sources.reduce((sum, row) => sum + row.amount, 0));
  return {
    applicationSourceReversals,
    allocationReversals,
    cashCredit:
      amount > 0
        ? {
            sourceEventKey: `return-clawback:${input.eventKey}`,
            amount,
            sources,
          }
        : null,
  };
}

export function planClawbackRestoration(input: {
  snapshotId: string;
  activeApplicationSources: { id: string; active: number }[];
  activeCashAllocations: { allocationId: string; amount: number }[];
}): ClawbackPlan {
  const applicationSourceReversals = input.activeApplicationSources
    .filter((row) => row.active > 0)
    .map((row) => ({
      applicationSourceId: row.id,
      amount: roundMoney(row.active),
      reversalKey: `clawback:${input.snapshotId}:application-source:${row.id}`,
    }));
  const sources = input.activeCashAllocations
    .filter((row) => row.amount > 0)
    .map((row) => ({
      allocationId: row.allocationId,
      amount: roundMoney(row.amount),
    }));
  const amount = roundMoney(sources.reduce((sum, row) => sum + row.amount, 0));
  return {
    applicationSourceReversals,
    allocationReversals: sources.map((source) => ({
      allocationId: source.allocationId,
      amount: source.amount,
      reversalKey: `clawback:${input.snapshotId}:allocation:${source.allocationId}`,
    })),
    cashCredit:
      amount > 0
        ? {
            sourceEventKey: `clawback:${input.snapshotId}`,
            amount,
            sources,
          }
        : null,
  };
}

export type RemittanceCreditInvalidation = {
  applicationSourceReversals: {
    applicationSourceId: string;
    amount: number;
    reversalKey: string;
  }[];
  offsets: {
    creditId: string;
    amount: number;
    sources: { creditSourceId: string; amount: number }[];
  }[];
};

/**
 * Bank reversal invalidates only credit sources funded by this remittance.
 * Other remittances' sources on the same credit stay applied.
 */
export function planRemittanceCreditInvalidation(input: {
  reversalId: string;
  creditSources: {
    creditSourceId: string;
    creditId: string;
    amount: number;
  }[];
  applicationSources: ActiveApplicationSource[];
}): RemittanceCreditInvalidation {
  const applicationSourceReversals: RemittanceCreditInvalidation['applicationSourceReversals'] =
    [];
  const offsetsByCredit = new Map<
    string,
    { amount: number; sources: { creditSourceId: string; amount: number }[] }
  >();

  for (const source of input.creditSources) {
    const amount = roundMoney(source.amount);
    if (!(amount > 0)) continue;
    const linked = input.applicationSources
      .filter((row) => row.creditSourceId === source.creditSourceId && row.active > 0)
      .sort((a, b) => {
        const time = a.createdAt.localeCompare(b.createdAt);
        if (time !== 0) return time;
        return a.id.localeCompare(b.id);
      });
    let left = amount;
    for (const row of linked) {
      if (!(left > 0)) break;
      const take = roundMoney(Math.min(left, row.active));
      if (!(take > 0)) continue;
      applicationSourceReversals.push({
        applicationSourceId: row.id,
        amount: take,
        reversalKey: `remittance-reversal:${input.reversalId}:application-source:${row.id}`,
      });
      left = roundMoney(left - take);
    }
    const bucket = offsetsByCredit.get(source.creditId) ?? { amount: 0, sources: [] };
    bucket.amount = roundMoney(bucket.amount + amount);
    bucket.sources.push({ creditSourceId: source.creditSourceId, amount });
    offsetsByCredit.set(source.creditId, bucket);
  }

  return {
    applicationSourceReversals,
    offsets: [...offsetsByCredit.entries()].map(([creditId, bucket]) => ({
      creditId,
      amount: bucket.amount,
      sources: bucket.sources,
    })),
  };
}

export type SettleableCommissionPlacement = 'retained' | 'cash' | 'none';

/**
 * One settleable line belongs to one balance.
 * Card commission Winger kept (stripe, test, or live) is earned and retained.
 * Cash on delivery and Lipa stay in the outstanding cash balance.
 */
export function settleableCommissionPlacement(
  paymentMode: string,
): SettleableCommissionPlacement {
  if (paymentMode === 'cod' || paymentMode === 'lipa') return 'cash';
  if (
    paymentMode === 'stripe' ||
    paymentMode === 'test' ||
    paymentMode === 'live'
  ) {
    return 'retained';
  }
  return 'none';
}

export function grossCommissionOutstanding(
  lines: { commissionAmount: number; cashAllocated: number }[],
): number {
  return roundMoney(
    lines.reduce(
      (sum, line) => sum + Math.max(0, line.commissionAmount - line.cashAllocated),
      0,
    ),
  );
}

export function appliedRefundCredit(activeApplicationSources: number[]): number {
  return roundMoney(activeApplicationSources.reduce((sum, amount) => sum + amount, 0));
}

export function unappliedRefundCredit(
  credits: { amount: number; offsets: number; applied: number }[],
): number {
  return roundMoney(
    credits.reduce(
      (sum, credit) => sum + Math.max(0, credit.amount - credit.offsets - credit.applied),
      0,
    ),
  );
}

/**
 * Verified cash that can still be allocated. creditHeld is cash already
 * turned into a credit by an allocation reversal. A manual release has no
 * credit source, so it stays allocatable.
 */
export function unappliedVerifiedCash(
  remittances: { verifiedAmountUsd: number; cashAllocated: number; creditHeld?: number }[],
): number {
  return roundMoney(
    remittances.reduce(
      (sum, row) =>
        sum +
        Math.max(
          0,
          row.verifiedAmountUsd - row.cashAllocated - Number(row.creditHeld ?? 0),
        ),
      0,
    ),
  );
}

export function cashCommissionCollected(activeAllocations: number[]): number {
  return roundMoney(activeAllocations.reduce((sum, amount) => sum + amount, 0));
}

export function netAmountDue(
  grossOutstanding: number,
  appliedCredit: number,
  unappliedCash: number,
): number {
  return roundMoney(
    Math.max(0, grossOutstanding - appliedCredit - unappliedCash),
  );
}

/** USD per 1 TZS, or TZS per 1 USD. Supplier-entered rates are not accepted. */
export function verifiedUsdFromClaim(input: {
  claimedAmount: number;
  claimedCurrency: string;
  settlementCurrency: string;
  quoteBase: string;
  quoteCurrency: string;
  rate: number;
}): number {
  const claimed = roundMoney(input.claimedAmount);
  const claimedCurrency = input.claimedCurrency.trim().toUpperCase();
  const settlement = input.settlementCurrency.trim().toUpperCase();
  if (claimedCurrency === settlement) return claimed;
  const rate = input.rate;
  if (!(rate > 0) || !Number.isFinite(rate)) {
    throw new Error('Exchange rate is required');
  }
  const base = input.quoteBase.trim().toUpperCase();
  const quote = input.quoteCurrency.trim().toUpperCase();
  if (base === claimedCurrency && quote === settlement) {
    return roundMoney(claimed * rate);
  }
  if (base === settlement && quote === claimedCurrency) {
    return roundMoney(claimed / rate);
  }
  throw new Error('Exchange rate pair does not convert the claimed currency');
}
