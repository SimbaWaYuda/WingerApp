export type DeliveryMethod = 'express' | 'standard' | 'pickup';

export type SupplierDeliveryQuote = {
  supplierName: string;
  merchandiseSubtotal: number;
  standardDeliveryFee: number;
  expressDeliveryFee: number;
  pickupDeliveryFee: number;
  freeDeliveryThreshold: number | null;
};

export function normalizeDeliveryMethod(method?: string): DeliveryMethod {
  const normalized = (method ?? 'standard').trim().toLowerCase();
  if (normalized === 'express' || normalized === 'pickup') return normalized;
  return 'standard';
}

export function deliveryFeeForSupplier(
  method: DeliveryMethod,
  supplier: SupplierDeliveryQuote,
): number {
  if (method === 'pickup') return roundMoney(supplier.pickupDeliveryFee);
  if (method === 'express') return roundMoney(supplier.expressDeliveryFee);
  const threshold = supplier.freeDeliveryThreshold;
  if (
    threshold != null &&
    Number.isFinite(threshold) &&
    supplier.merchandiseSubtotal + 0.001 >= threshold
  ) {
    return 0;
  }
  return roundMoney(supplier.standardDeliveryFee);
}

export function estimateLabel(method: DeliveryMethod, city: string): string {
  switch (method) {
    case 'express':
      return `1–2 days to ${city}`;
    case 'pickup':
      return `Ready for pickup in ${city}`;
    default:
      return `3–5 days to ${city}`;
  }
}

/** Product subtotal is taxed at 8%. Delivery is quoted per supplier and stays out of tax. */
export function computeFulfillmentFees(input: {
  subtotal: number;
  deliveryMethod?: string;
  city?: string;
  suppliers: SupplierDeliveryQuote[];
}) {
  const method = normalizeDeliveryMethod(input.deliveryMethod);
  const city = (input.city ?? 'Nairobi').trim() || 'Nairobi';
  const suppliers =
    input.suppliers.length > 0
      ? input.suppliers
      : [
          {
            supplierName: 'Supplier',
            merchandiseSubtotal: input.subtotal,
            standardDeliveryFee: 4.99,
            expressDeliveryFee: 9.99,
            pickupDeliveryFee: 0,
            freeDeliveryThreshold: null,
          },
        ];
  const shipments = suppliers.map((supplier) => ({
    supplierName: supplier.supplierName,
    deliveryMethod: method,
    fee: deliveryFeeForSupplier(method, supplier),
    estimate: estimateLabel(method, city),
  }));
  const deliveryFee = roundMoney(
    shipments.reduce((sum, shipment) => sum + shipment.fee, 0),
  );
  const tax = roundMoney(input.subtotal * 0.08);
  const subtotal = roundMoney(input.subtotal);
  return {
    subtotal,
    deliveryFee,
    tax,
    total: roundMoney(subtotal + deliveryFee + tax),
    deliveryMethod: method,
    shipments,
  };
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
