import { resolveOrderDeliveryAddress } from './delivery-address';

describe('resolveOrderDeliveryAddress', () => {
  it('keeps Tegeta / Dar es Salaam and never substitutes Westlands/Nairobi', () => {
    const result = resolveOrderDeliveryAddress({
      deliveryMethod: 'standard',
      addressLine: 'Tegeta',
      city: 'Dar es Salaam',
    });
    expect(result).toEqual({
      ok: true,
      value: { addressLine: 'Tegeta', city: 'Dar es Salaam' },
    });
  });

  it('rejects missing addressLine for delivery (card/COD/Lipa alike)', () => {
    const result = resolveOrderDeliveryAddress({
      deliveryMethod: 'express',
      addressLine: '  ',
      city: 'Dar es Salaam',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/address/i);
    }
  });

  it('rejects missing city for delivery', () => {
    const result = resolveOrderDeliveryAddress({
      deliveryMethod: 'standard',
      addressLine: 'Tegeta',
      city: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/city/i);
    }
  });

  it('does not require street address for pickup', () => {
    const result = resolveOrderDeliveryAddress({
      deliveryMethod: 'pickup',
      addressLine: '',
      city: '',
    });
    expect(result).toEqual({
      ok: true,
      value: { addressLine: null, city: null },
    });
  });

  it('keeps optional pickup city/address when provided', () => {
    const result = resolveOrderDeliveryAddress({
      deliveryMethod: 'pickup',
      addressLine: 'Hub counter',
      city: 'Dar es Salaam',
    });
    expect(result).toEqual({
      ok: true,
      value: { addressLine: 'Hub counter', city: 'Dar es Salaam' },
    });
  });

  it('does not invent Westlands/Nairobi when fields are empty', () => {
    const result = resolveOrderDeliveryAddress({
      deliveryMethod: 'standard',
      addressLine: undefined,
      city: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.toLowerCase()).not.toContain('westlands');
      expect(result.message.toLowerCase()).not.toContain('nairobi');
    }
  });
});
