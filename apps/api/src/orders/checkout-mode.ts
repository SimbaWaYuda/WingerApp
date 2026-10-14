export type CardCheckoutMode = 'demo' | 'test' | 'live';

/** How card checkout behaves from the Stripe secret. A missing key stays demo. */
export function cardCheckoutMode(secret: string | null | undefined): CardCheckoutMode {
  const key = secret?.trim() ?? '';
  if (key.startsWith('sk_live_')) return 'live';
  if (key.startsWith('sk_test_')) return 'test';
  return 'demo';
}
