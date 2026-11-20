/** True only when NODE_ENV trims to "production", ignoring case. */
export function isProductionEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
}
