/**
 * Street line for customer profile save.
 * Never invents Westlands or another geographic default.
 */
export function resolveProfileAddressLine(
  addressLine?: string | null,
): string | null {
  const trimmed = (addressLine ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}
