/**
 * UTC wall-clock helpers for Order TIMESTAMP WITHOUT TIME ZONE fields.
 *
 * Convention (S2.6.20.4): every stored value is the UTC calendar components of
 * the intended instant. Comparisons bind ISO-8601 UTC strings cast to
 * `timestamp` so PostgreSQL session TimeZone cannot shift the predicate.
 */

/** PostgreSQL expression: current UTC wall clock as timestamp without time zone. */
export const PG_UTC_WALL_CLOCK_NOW = `(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`;

/** ISO-8601 UTC string suitable for `${iso}::timestamp` predicates and writes. */
export function utcWallClockIso(ms: number = Date.now()): string {
  return new Date(ms).toISOString();
}

type RawExecutor = {
  $executeRaw: (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown>;
};

/**
 * First-write stamp for stripeChargeAttemptAt using UTC wall-clock components.
 * Shared by OrdersService.markStripeChargeAttempt and timezone integration tests.
 */
export async function writeStripeChargeAttemptAtUtc(
  db: RawExecutor,
  orderId: string,
): Promise<void> {
  await db.$executeRaw`
    UPDATE "Order"
    SET "stripeChargeAttemptAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
    WHERE "id" = ${orderId}
      AND "stripeChargeAttemptAt" IS NULL
  `;
}
