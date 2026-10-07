import { normalizePhoneE164, toWhatsAppAddress } from './whatsapp.util';
import {
  refundStatusMessage,
  returnStatusMessage,
} from './notifications.service';

describe('whatsapp.util', () => {
  it('normalizes E.164 phones', () => {
    expect(normalizePhoneE164('+254 712 345 678')).toBe('+254712345678');
    expect(normalizePhoneE164('254712345678')).toBe('+254712345678');
    expect(normalizePhoneE164('abc')).toBeNull();
  });

  it('builds whatsapp addresses', () => {
    expect(toWhatsAppAddress('+254712345678')).toBe('whatsapp:+254712345678');
  });
});

describe('return/refund notify copy', () => {
  it('covers approve and refund issued', () => {
    expect(returnStatusMessage('APPROVED', 'W-1', 'Laptop')?.type).toBe(
      'RETURN_APPROVED',
    );
    expect(refundStatusMessage('ISSUED', 'W-1', 'Laptop')?.type).toBe(
      'REFUND_ISSUED',
    );
  });
});
