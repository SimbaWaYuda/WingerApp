/** Locked per-supplier checkout buckets in settlement currency. */
export type SettlementShipment = {
  supplierId: string;
  supplierName: string;
  merchandise: number;
  deliveryFee: number;
  merchandiseTax: number;
  deliveryTax: number;
};

/** Settlement buckets plus the customer's payment-currency split. */
export type LockedPaymentShipment = SettlementShipment & {
  paymentMerchandise: number;
  paymentDelivery: number;
  paymentTax: number;
};

export function roundMoney(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

export function shipmentSettlementTotal(row: SettlementShipment): number {
  return roundMoney(
    row.merchandise + row.deliveryFee + row.merchandiseTax + row.deliveryTax,
  );
}

export function shipmentPaymentTotal(row: {
  paymentMerchandise: number;
  paymentDelivery: number;
  paymentTax: number;
}): number {
  return roundMoney(
    row.paymentMerchandise + row.paymentDelivery + row.paymentTax,
  );
}

export function isLiveOrderLine(status: string): boolean {
  return status !== 'CANCELLED' && status !== 'RETURNED';
}

/**
 * Split the customer charge across supplier buckets. The last supplier
 * absorbs leftover cents so the shares equal paymentAmount.
 */
export function lockShipmentPayments(
  shipments: SettlementShipment[],
  paymentAmount: number,
): LockedPaymentShipment[] {
  const rows = shipments.filter((row) => row.supplierId);
  const payment = roundMoney(paymentAmount);
  const settlementTotals = rows.map(shipmentSettlementTotal);
  const settlementSum = roundMoney(
    settlementTotals.reduce((sum, value) => sum + value, 0),
  );
  let remaining = payment;
  return rows.map((row, index) => {
    const last = index === rows.length - 1;
    const share =
      settlementSum <= 0
        ? 0
        : last
          ? remaining
          : roundMoney(payment * (settlementTotals[index] / settlementSum));
    if (!last) remaining = roundMoney(remaining - share);
    const settlement = settlementTotals[index];
    const paymentMerchandise =
      settlement <= 0 ? 0 : roundMoney(share * (row.merchandise / settlement));
    const paymentDelivery =
      settlement <= 0 ? 0 : roundMoney(share * (row.deliveryFee / settlement));
    const paymentTax = roundMoney(share - paymentMerchandise - paymentDelivery);
    return {
      ...row,
      paymentMerchandise,
      paymentDelivery,
      paymentTax: paymentTax < 0 ? 0 : paymentTax,
    };
  });
}

function paymentTaxParts(row: LockedPaymentShipment): {
  merchandise: number;
  delivery: number;
} {
  const tax = roundMoney(row.merchandiseTax + row.deliveryTax);
  if (tax <= 0 || row.paymentTax <= 0) {
    return { merchandise: 0, delivery: 0 };
  }
  const merchandise = roundMoney(
    row.paymentTax * (row.merchandiseTax / tax),
  );
  return {
    merchandise,
    delivery: roundMoney(row.paymentTax - merchandise),
  };
}

/**
 * Payment-currency refund for returned/cancelled merchandise of one supplier.
 * Delivery and delivery tax refund only when that supplier has no remaining live lines.
 */
export function refundPaymentForSupplierAction(params: {
  shipment: LockedPaymentShipment & { refundedAmount?: number };
  returnedMerchandise: number;
  includeDelivery: boolean;
}): number {
  const merchandise = Number(params.shipment.merchandise);
  const returned = Number(params.returnedMerchandise);
  if (!(merchandise > 0) || !(returned > 0)) {
    const deliveryOnly = params.includeDelivery
      ? roundMoney(
          params.shipment.paymentDelivery +
            paymentTaxParts(params.shipment).delivery,
        )
      : 0;
    return capRefund(params.shipment, deliveryOnly);
  }
  const share = Math.min(returned / merchandise, 1);
  const tax = paymentTaxParts(params.shipment);
  let amount = roundMoney(
    share * params.shipment.paymentMerchandise + share * tax.merchandise,
  );
  if (params.includeDelivery) {
    amount = roundMoney(amount + params.shipment.paymentDelivery + tax.delivery);
  }
  return capRefund(params.shipment, amount);
}

/**
 * COD cash for a supplier's still-live lines. Cancelled suppliers collect nothing.
 * Delivery is included while that supplier still has a live line.
 */
export function remainingCodPayment(params: {
  shipment: LockedPaymentShipment;
  liveMerchandise: number;
}): number {
  const live = Number(params.liveMerchandise);
  if (!(live > 0)) return 0;
  return refundPaymentForSupplierAction({
    shipment: { ...params.shipment, refundedAmount: 0 },
    returnedMerchandise: live,
    includeDelivery: true,
  });
}

function capRefund(
  shipment: LockedPaymentShipment & { refundedAmount?: number },
  amount: number,
): number {
  const remaining = roundMoney(
    shipmentPaymentTotal(shipment) - Number(shipment.refundedAmount ?? 0),
  );
  if (remaining <= 0) return 0;
  return Math.min(roundMoney(amount), remaining);
}
