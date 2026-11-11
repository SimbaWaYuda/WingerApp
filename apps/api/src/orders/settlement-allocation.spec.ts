import {
  lockShipmentPayments,
  refundPaymentForSupplierAction,
  remainingCodPayment,
  shipmentPaymentTotal,
} from './settlement-allocation';

const kijani = {
  supplierId: 's-kijani',
  supplierName: 'Kijani Tech',
  merchandise: 40,
  deliveryFee: 4.99,
  merchandiseTax: 3.2,
  deliveryTax: 0,
};

const atlas = {
  supplierId: 's-atlas',
  supplierName: 'Atlas Home',
  merchandise: 60,
  deliveryFee: 0,
  merchandiseTax: 4.8,
  deliveryTax: 0,
};

describe('settlement allocation', () => {
  it('makes a single supplier’s payment buckets equal the customer charge', () => {
    const [row] = lockShipmentPayments(
      [
        {
          ...kijani,
          merchandise: 50,
          deliveryFee: 4.99,
          merchandiseTax: 4,
          deliveryTax: 0,
        },
      ],
      58.99,
    );
    expect(shipmentPaymentTotal(row)).toBe(58.99);
  });

  it('splits a mixed cart so the last supplier absorbs leftover cents', () => {
    const locked = lockShipmentPayments([kijani, atlas], 112.99);
    expect(locked).toHaveLength(2);
    expect(
      shipmentPaymentTotal(locked[0]) + shipmentPaymentTotal(locked[1]),
    ).toBe(112.99);
    expect(locked[0].paymentDelivery).toBeGreaterThan(0);
    expect(locked[1].paymentDelivery).toBe(0);
  });

  it('refunds only supplier A’s goods and tax, not B’s delivery', () => {
    const [a, b] = lockShipmentPayments([kijani, atlas], 112.99);
    const refundA = refundPaymentForSupplierAction({
      shipment: a,
      returnedMerchandise: 40,
      includeDelivery: true,
    });
    const refundB = refundPaymentForSupplierAction({
      shipment: b,
      returnedMerchandise: 60,
      includeDelivery: true,
    });
    expect(refundA).toBe(shipmentPaymentTotal(a));
    expect(refundB).toBe(shipmentPaymentTotal(b));
    expect(refundA + refundB).toBe(112.99);
    expect(
      refundPaymentForSupplierAction({
        shipment: a,
        returnedMerchandise: 20,
        includeDelivery: false,
      }),
    ).toBeLessThan(refundA);
  });

  it('refunds A’s delivery only when every A line is gone', () => {
    const [a] = lockShipmentPayments(
      [
        {
          ...kijani,
          merchandise: 40,
          deliveryFee: 4.99,
          merchandiseTax: 3.2,
          deliveryTax: 0.4,
        },
      ],
      48.59,
    );
    const partial = refundPaymentForSupplierAction({
      shipment: a,
      returnedMerchandise: 20,
      includeDelivery: false,
    });
    const full = refundPaymentForSupplierAction({
      shipment: a,
      returnedMerchandise: 40,
      includeDelivery: true,
    });
    expect(partial).toBeLessThan(full);
    expect(full).toBe(48.59);
    expect(full - partial).toBeGreaterThan(4);
  });

  it('keeps pickup delivery at zero in COD and refunds', () => {
    const [row] = lockShipmentPayments(
      [
        {
          ...kijani,
          deliveryFee: 0,
          merchandiseTax: 3.2,
          deliveryTax: 0,
        },
      ],
      43.2,
    );
    expect(row.paymentDelivery).toBe(0);
    expect(
      remainingCodPayment({ shipment: row, liveMerchandise: 40 }),
    ).toBe(43.2);
    expect(
      remainingCodPayment({ shipment: row, liveMerchandise: 0 }),
    ).toBe(0);
  });

  it('does not collect COD for a cancelled supplier', () => {
    const [a, b] = lockShipmentPayments([kijani, atlas], 112.99);
    expect(remainingCodPayment({ shipment: a, liveMerchandise: 0 })).toBe(0);
    expect(remainingCodPayment({ shipment: b, liveMerchandise: 60 })).toBe(
      shipmentPaymentTotal(b),
    );
  });
});
