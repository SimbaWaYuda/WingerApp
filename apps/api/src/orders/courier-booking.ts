/** Next courier tracking reference. The first booking is CR-10001. */
export function nextCourierReference(existingCount: number): string {
  const count = Number.isFinite(existingCount) && existingCount > 0 ? Math.floor(existingCount) : 0;
  return `CR-${count + 10001}`;
}
