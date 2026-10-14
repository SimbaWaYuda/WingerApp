export type DeliveryMethod = 'express' | 'standard' | 'pickup';
export type CarrierMode = 'supplier' | 'courier';

export type SupplierDeliveryQuote = {
  supplierId: string;
  supplierName: string;
  merchandiseSubtotal: number;
  standardDeliveryFee: number;
  expressDeliveryFee: number;
  pickupDeliveryFee: number;
  freeDeliveryThreshold: number | null;
  /** Percent used when the city and the product have no rate. 0 means no tax. */
  taxRatePercent: number;
  /** Rate for the checkout city. Null when that city has no rule. */
  cityTaxRatePercent?: number | null;
  /**
   * Per-item rates. Null on a line means use the city rate, then the supplier rate.
   * When omitted, the whole merchandise subtotal uses the city or supplier rate.
   */
  lines?: { lineTotal: number; taxRatePercent: number | null }[];
  taxOnDelivery: boolean;
  /** supplier delivers, or a named courier. Pickup clears this on the shipment. */
  carrier: CarrierMode;
  courierName: string | null;
};

export function normalizeDeliveryMethod(method?: string): DeliveryMethod {
  const normalized = (method ?? 'standard').trim().toLowerCase();
  if (normalized === 'express' || normalized === 'pickup') return normalized;
  return 'standard';
}

export function normalizeCarrier(value?: string | null): CarrierMode {
  return (value ?? '').trim().toLowerCase() === 'courier' ? 'courier' : 'supplier';
}

/** Pickup has no carrier. A courier name is the label locked at checkout. */
export function carrierForShipment(
  method: DeliveryMethod,
  supplier: SupplierDeliveryQuote,
): { carrier: CarrierMode | null; courierName: string | null } {
  if (method === 'pickup') return { carrier: null, courierName: null };
  const carrier = normalizeCarrier(supplier.carrier);
  if (carrier === 'courier') {
    const name = (supplier.courierName ?? '').trim();
    return { carrier, courierName: name || 'Courier' };
  }
  return { carrier: 'supplier', courierName: null };
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

/** Checkout city key. Empty when the customer has not entered a city. */
export function normalizeCityKey(city?: string | null): string {
  return (city ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Product rate wins, then the delivery city, then the supplier default. */
export function resolveTaxRate(
  productRate: number | null | undefined,
  cityRate: number | null | undefined,
  supplierRate: number,
): number {
  if (productRate != null && Number.isFinite(productRate)) return productRate;
  if (cityRate != null && Number.isFinite(cityRate)) return cityRate;
  return Number.isFinite(supplierRate) ? supplierRate : 8;
}

export function cityTaxRateFor(
  rules: { cityKey: string; taxRatePercent: number }[],
  city?: string | null,
): number | null {
  const key = normalizeCityKey(city);
  if (!key) return null;
  const match = rules.find((rule) => rule.cityKey === key);
  return match ? match.taxRatePercent : null;
}

export function taxForSupplier(deliveryFee: number, supplier: SupplierDeliveryQuote): number {
  const lines = supplier.lines;
  const merchandiseTax =
    lines && lines.length > 0
      ? lines.reduce((sum, line) => {
          const rate = resolveTaxRate(
            line.taxRatePercent,
            supplier.cityTaxRatePercent,
            supplier.taxRatePercent,
          );
          return sum + (line.lineTotal * rate) / 100;
        }, 0)
      : (supplier.merchandiseSubtotal *
          resolveTaxRate(null, supplier.cityTaxRatePercent, supplier.taxRatePercent)) /
        100;
  const deliveryRate = resolveTaxRate(
    null,
    supplier.cityTaxRatePercent,
    supplier.taxRatePercent,
  );
  const deliveryTax = supplier.taxOnDelivery ? (deliveryFee * deliveryRate) / 100 : 0;
  return roundMoney(merchandiseTax + deliveryTax);
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

/** Each supplier's tax rate applies to their items, and to their delivery fee when they opted in. */
export function computeFulfillmentFees(input: {
  subtotal: number;
  deliveryMethod?: string;
  city?: string;
  suppliers: SupplierDeliveryQuote[];
}) {
  const method = normalizeDeliveryMethod(input.deliveryMethod);
  const city = (input.city ?? 'Nairobi').trim() || 'Nairobi';
  const fallback: SupplierDeliveryQuote = {
    supplierId: '',
    supplierName: 'Supplier',
    merchandiseSubtotal: input.subtotal,
    standardDeliveryFee: 4.99,
    expressDeliveryFee: 9.99,
    pickupDeliveryFee: 0,
    freeDeliveryThreshold: null,
    taxRatePercent: 8,
    taxOnDelivery: false,
    carrier: 'supplier',
    courierName: null,
  };
  const suppliers = input.suppliers.length > 0 ? input.suppliers : [fallback];
  const shipments = suppliers.map((supplier) => {
    const fee = deliveryFeeForSupplier(method, supplier);
    const carrier = carrierForShipment(method, supplier);
    return {
      supplierId: supplier.supplierId,
      supplierName: supplier.supplierName,
      deliveryMethod: method,
      fee,
      tax: taxForSupplier(fee, supplier),
      estimate: estimateLabel(method, city),
      carrier: carrier.carrier,
      courierName: carrier.courierName,
    };
  });
  const deliveryFee = roundMoney(
    shipments.reduce((sum, shipment) => sum + shipment.fee, 0),
  );
  const tax = roundMoney(shipments.reduce((sum, shipment) => sum + shipment.tax, 0));
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
