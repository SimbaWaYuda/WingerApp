/** Normalize to E.164-ish digits with leading +. Returns null if unusable. */
export function normalizePhoneE164(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return null;
  return hasPlus || digits.length >= 10 ? `+${digits}` : null;
}

export function toWhatsAppAddress(phoneE164: string): string {
  return phoneE164.startsWith('whatsapp:')
    ? phoneE164
    : `whatsapp:${phoneE164}`;
}
