export function roundMoney(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

/** Item total minus commission. Tax and delivery are not part of this amount. */
export function supplierNetSettlement(lineTotal: number, commissionAmount: number): number {
  const net = roundMoney(lineTotal - commissionAmount);
  return net > 0 ? net : 0;
}

/**
 * Amount to transfer in the currency of the card charge.
 * When the customer paid in another currency, the locked checkout rate converts the settlement net.
 */
export function supplierTransferAmount(input: {
  lineTotal: number;
  commissionAmount: number;
  settlementCurrency: string;
  paymentCurrency: string;
  fxRate: number | null;
}): { amount: number; currency: string } | null {
  const net = supplierNetSettlement(input.lineTotal, input.commissionAmount);
  if (net <= 0) return null;
  const settlement = input.settlementCurrency.trim().toUpperCase();
  const payment = input.paymentCurrency.trim().toUpperCase() || settlement;
  if (payment === settlement) return { amount: net, currency: payment };
  const rate = input.fxRate;
  if (rate == null || !(rate > 0) || !Number.isFinite(rate)) return null;
  const amount = roundMoney(net * rate);
  if (amount <= 0) return null;
  return { amount, currency: payment };
}

/**
 * Transfer in the currency Stripe settled for the charge.
 * A TZS card can settle into a USD balance. The supplier still receives the settlement net.
 */
export function supplierTransferForBalance(input: {
  lineTotal: number;
  commissionAmount: number;
  settlementCurrency: string;
  paymentCurrency: string;
  fxRate: number | null;
  balanceCurrency: string;
}): { amount: number; currency: string } | null {
  const net = supplierNetSettlement(input.lineTotal, input.commissionAmount);
  if (net <= 0) return null;
  const settlement = input.settlementCurrency.trim().toUpperCase();
  const payment = input.paymentCurrency.trim().toUpperCase() || settlement;
  const balance = input.balanceCurrency.trim().toUpperCase();
  if (!balance) return null;
  if (balance === settlement) return { amount: net, currency: balance };
  if (balance === payment) {
    const rate = input.fxRate;
    if (rate == null || !(rate > 0) || !Number.isFinite(rate)) return null;
    const amount = roundMoney(net * rate);
    if (amount <= 0) return null;
    return { amount, currency: balance };
  }
  return null;
}
