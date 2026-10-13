import { cardElementHtml, isStripePublishableKey } from './card-element.page';

describe('stripe card element page', () => {
  it('accepts only publishable keys', () => {
    expect(isStripePublishableKey('pk_test_abc123')).toBe(true);
    expect(isStripePublishableKey('pk_live_abc123')).toBe(true);
    expect(isStripePublishableKey('sk_test_abc123')).toBe(false);
    expect(isStripePublishableKey('pk_test_')).toBe(false);
    expect(isStripePublishableKey('')).toBe(false);
  });

  it('does not embed a secret key', () => {
    const html = cardElementHtml('sk_test_secretvalue');
    expect(html).not.toContain('sk_test_secretvalue');
    expect(html).toContain('Card payment is not configured');
    expect(html).toContain('https://js.stripe.com/v3/');
  });

  it('embeds a publishable key for Stripe.js', () => {
    const html = cardElementHtml('pk_test_abc123');
    expect(html).toContain('"pk_test_abc123"');
    expect(html).toContain('wingerCreatePaymentMethod');
    expect(html).not.toContain('sk_');
  });
});
