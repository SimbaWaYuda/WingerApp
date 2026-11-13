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

export function unappliedVerifiedCash(
  remittances: { verifiedAmountUsd: number; cashAllocated: number }[],
): number {
  return roundMoney(
    remittances.reduce(
      (sum, row) => sum + Math.max(0, row.verifiedAmountUsd - row.cashAllocated),
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
