import { normalizeDeliveryMethod } from './delivery-fees';

export type ResolvedDeliveryAddress = {
  addressLine: string | null;
  city: string | null;
};

/**
 * Resolve the address that must be stored on a new order.
 * Delivery (express/standard) requires a real street and city — never substitutes
 * geographic defaults. Pickup does not require a street address.
 *
 * Future (GAP-ADDR-02): a multi-address book should supply the confirmed
 * addressLine/city here; do not reintroduce silent geographic defaults.
 */
export function resolveOrderDeliveryAddress(input: {
  deliveryMethod?: string | null;
  addressLine?: string | null;
  city?: string | null;
}): { ok: true; value: ResolvedDeliveryAddress } | { ok: false; message: string } {
  const method = normalizeDeliveryMethod(input.deliveryMethod ?? undefined);
  const addressLine = (input.addressLine ?? '').trim();
  const city = (input.city ?? '').trim();

  if (method === 'pickup') {
    return {
      ok: true,
      value: {
        addressLine: addressLine.length > 0 ? addressLine : null,
        city: city.length > 0 ? city : null,
      },
    };
  }

  if (!addressLine) {
    return { ok: false, message: 'Address is required for delivery' };
  }
  if (!city) {
    return { ok: false, message: 'City is required for delivery' };
  }
  return { ok: true, value: { addressLine, city } };
}
