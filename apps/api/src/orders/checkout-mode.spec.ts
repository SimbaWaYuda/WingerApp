import { cardCheckoutMode } from './checkout-mode';

describe('cardCheckoutMode', () => {
  it('treats a test secret as test card checkout', () => {
    expect(cardCheckoutMode('sk_test_abc')).toBe('test');
  });

  it('treats a live secret as live and a blank secret as demo', () => {
    expect(cardCheckoutMode('sk_live_abc')).toBe('live');
    expect(cardCheckoutMode('')).toBe('demo');
    expect(cardCheckoutMode(undefined)).toBe('demo');
  });
});
