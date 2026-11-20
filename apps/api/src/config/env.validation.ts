/**
 * Production environment checks for the NestJS API.
 * Strict rules apply only when NODE_ENV=production (see Dockerfile / Render).
 * Local development and demo checkout behaviour are unchanged when not production.
 */
import { isProductionEnv } from './env-mode';

const DEV_JWT_PLACEHOLDERS = new Set([
  'winger-dev-secret-change-me',
  'changeme',
  'change-me',
  'secret',
  'jwt-secret',
]);

export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: string[]) {
    const unique = [...new Set(issues.filter(Boolean))];
    super(
      unique.length === 0
        ? 'Invalid production environment'
        : `Invalid production environment:\n${unique
            .map((issue) => `- ${issue}`)
            .join('\n')}`,
    );
    this.name = 'EnvValidationError';
    this.issues = unique;
  }
}

function read(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? '').trim();
}

function isWeakJwtSecret(value: string): boolean {
  if (value.length < 32) return true;
  const lower = value.toLowerCase();
  if (DEV_JWT_PLACEHOLDERS.has(lower)) return true;
  if (lower.includes('change-me') || lower.includes('changeme')) return true;
  if (lower.includes('winger-dev-secret')) return true;
  return false;
}

function looksLikePostgresUrl(value: string): boolean {
  return (
    value.startsWith('postgresql://') || value.startsWith('postgres://')
  );
}

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.host) && !value.endsWith('/');
  } catch {
    return false;
  }
}

/**
 * Validates env for production. No-op when NODE_ENV is not production.
 * Never includes secret values in thrown messages — names only.
 */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (!isProductionEnv(env)) {
    return;
  }

  const issues: string[] = [];

  const databaseUrl = read(env, 'DATABASE_URL');
  if (!databaseUrl) {
    issues.push('DATABASE_URL is required in production');
  } else if (!looksLikePostgresUrl(databaseUrl)) {
    issues.push(
      'DATABASE_URL must be a PostgreSQL URL (postgresql:// or postgres://)',
    );
  }

  const jwtSecret = read(env, 'JWT_SECRET');
  if (!jwtSecret) {
    issues.push('JWT_SECRET is required in production');
  } else if (isWeakJwtSecret(jwtSecret)) {
    issues.push(
      'JWT_SECRET is missing, too short, or matches a known development placeholder',
    );
  }

  const portRaw = read(env, 'PORT');
  if (portRaw) {
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      issues.push('PORT must be an integer between 1 and 65535 when set');
    }
  }

  const storageDriver = (read(env, 'STORAGE_DRIVER') || 'local').toLowerCase();
  if (storageDriver === 's3') {
    if (!read(env, 'S3_BUCKET')) {
      issues.push('S3_BUCKET is required when STORAGE_DRIVER=s3');
    }
    if (!read(env, 'S3_PUBLIC_BASE_URL')) {
      issues.push('S3_PUBLIC_BASE_URL is required when STORAGE_DRIVER=s3');
    }
    // R2 / MinIO / custom S3-compatible endpoints need an explicit endpoint.
    // Production architecture uses Cloudflare R2.
    if (!read(env, 'S3_ENDPOINT')) {
      issues.push(
        'S3_ENDPOINT is required when STORAGE_DRIVER=s3 (S3-compatible / R2 endpoint)',
      );
    }
    if (!read(env, 'AWS_ACCESS_KEY_ID')) {
      issues.push('AWS_ACCESS_KEY_ID is required when STORAGE_DRIVER=s3');
    }
    if (!read(env, 'AWS_SECRET_ACCESS_KEY')) {
      issues.push('AWS_SECRET_ACCESS_KEY is required when STORAGE_DRIVER=s3');
    }
  } else if (storageDriver !== 'local') {
    issues.push(
      'STORAGE_DRIVER must be "local" or "s3" in production',
    );
  }

  const stripeSecret = read(env, 'STRIPE_SECRET_KEY');
  if (!stripeSecret) {
    // Production may boot without Stripe so COD and Lipa still work.
    // An unconfigured card attempt is rejected and is never demo-paid.
    // A present but incomplete Stripe config is rejected below.
  } else {
    const mode =
      stripeSecret.startsWith('sk_live_')
        ? 'live'
        : stripeSecret.startsWith('sk_test_')
          ? 'test'
          : null;
    if (!mode) {
      issues.push(
        'STRIPE_SECRET_KEY must start with sk_test_ or sk_live_ when set in production',
      );
    }

    const webhookSecret = read(env, 'STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret) {
      issues.push(
        'STRIPE_WEBHOOK_SECRET is required in production when STRIPE_SECRET_KEY is set (demo checkout is not allowed with incomplete Stripe config)',
      );
    } else if (!webhookSecret.startsWith('whsec_')) {
      issues.push(
        'STRIPE_WEBHOOK_SECRET must be a Stripe webhook signing secret (whsec_...) when STRIPE_SECRET_KEY is set',
      );
    }

    const publicOrigin = read(env, 'PUBLIC_API_ORIGIN');
    if (!publicOrigin) {
      issues.push(
        'PUBLIC_API_ORIGIN is required in production when STRIPE_SECRET_KEY is set (https origin, no trailing slash)',
      );
    } else if (!isHttpsOrigin(publicOrigin)) {
      issues.push(
        'PUBLIC_API_ORIGIN must be an https URL with no trailing slash when STRIPE_SECRET_KEY is set',
      );
    }
  }

  // PAYMENT_RECONCILE_WORKER_ENABLED: leave unset until separately authorised.
  // No hard-block in this stage (owner decision deferred).

  if (issues.length > 0) {
    throw new EnvValidationError(issues);
  }
}

/** Call before NestFactory.create(). Exits process on production validation failure. */
export function assertProductionEnvOrExit(
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    validateEnv(env);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      // eslint-disable-next-line no-console
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
