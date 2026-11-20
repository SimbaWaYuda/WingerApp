import {
  assertProductionEnvOrExit,
  EnvValidationError,
  validateEnv,
} from './env.validation';

function prodBase(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://winger:winger@db:5432/winger?schema=public',
    JWT_SECRET: 'production-jwt-secret-value-at-least-32-chars',
    STORAGE_DRIVER: 'local',
    ...overrides,
  };
}

describe('env.validation', () => {
  it('1: accepts a valid production configuration', () => {
    expect(() =>
      validateEnv(
        prodBase({
          STRIPE_SECRET_KEY: 'sk_test_exampleSecretKeyValue',
          STRIPE_WEBHOOK_SECRET: 'whsec_exampleWebhookSecret',
          PUBLIC_API_ORIGIN: 'https://api.example.com',
          STORAGE_DRIVER: 's3',
          S3_BUCKET: 'winger-uploads',
          S3_PUBLIC_BASE_URL: 'https://cdn.example.com',
          S3_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
          AWS_ACCESS_KEY_ID: 'r2-access-key-id',
          AWS_SECRET_ACCESS_KEY: 'r2-secret-access-key',
          S3_REGION: 'auto',
        }),
      ),
    ).not.toThrow();
  });

  it('2: rejects a missing production DATABASE_URL', () => {
    expect(() => validateEnv(prodBase({ DATABASE_URL: '' }))).toThrow(
      EnvValidationError,
    );
    try {
      validateEnv(prodBase({ DATABASE_URL: '' }));
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).not.toMatch(/postgresql:\/\//);
    }
  });

  it('3: rejects a missing or weak production JWT_SECRET', () => {
    expect(() => validateEnv(prodBase({ JWT_SECRET: '' }))).toThrow(
      /JWT_SECRET/,
    );
    expect(() =>
      validateEnv(prodBase({ JWT_SECRET: 'winger-dev-secret-change-me' })),
    ).toThrow(/JWT_SECRET/);
    expect(() => validateEnv(prodBase({ JWT_SECRET: 'short' }))).toThrow(
      /JWT_SECRET/,
    );
  });

  it('4: rejects missing Stripe webhook when card payments are configured', () => {
    expect(() =>
      validateEnv(
        prodBase({
          STRIPE_SECRET_KEY: 'sk_test_exampleSecretKeyValue',
          STRIPE_WEBHOOK_SECRET: '',
          PUBLIC_API_ORIGIN: 'https://api.example.com',
        }),
      ),
    ).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  it('5: allows production without Stripe when card payments are not configured', () => {
    expect(() =>
      validateEnv(
        prodBase({
          STRIPE_SECRET_KEY: '',
          STRIPE_WEBHOOK_SECRET: '',
        }),
      ),
    ).not.toThrow();
  });

  it('6: rejects missing S3 bucket or public URL when S3 is selected', () => {
    expect(() =>
      validateEnv(
        prodBase({
          STORAGE_DRIVER: 's3',
          S3_BUCKET: '',
          S3_PUBLIC_BASE_URL: 'https://cdn.example.com',
          S3_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
          AWS_ACCESS_KEY_ID: 'key',
          AWS_SECRET_ACCESS_KEY: 'secret-value-here',
        }),
      ),
    ).toThrow(/S3_BUCKET/);

    expect(() =>
      validateEnv(
        prodBase({
          STORAGE_DRIVER: 's3',
          S3_BUCKET: 'winger-uploads',
          S3_PUBLIC_BASE_URL: '',
          S3_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
          AWS_ACCESS_KEY_ID: 'key',
          AWS_SECRET_ACCESS_KEY: 'secret-value-here',
        }),
      ),
    ).toThrow(/S3_PUBLIC_BASE_URL/);
  });

  it('7: rejects missing R2 endpoint or credentials when S3 is selected', () => {
    expect(() =>
      validateEnv(
        prodBase({
          STORAGE_DRIVER: 's3',
          S3_BUCKET: 'winger-uploads',
          S3_PUBLIC_BASE_URL: 'https://cdn.example.com',
          S3_ENDPOINT: '',
          AWS_ACCESS_KEY_ID: 'key',
          AWS_SECRET_ACCESS_KEY: 'secret-value-here',
        }),
      ),
    ).toThrow(/S3_ENDPOINT/);

    expect(() =>
      validateEnv(
        prodBase({
          STORAGE_DRIVER: 's3',
          S3_BUCKET: 'winger-uploads',
          S3_PUBLIC_BASE_URL: 'https://cdn.example.com',
          S3_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
          AWS_ACCESS_KEY_ID: '',
          AWS_SECRET_ACCESS_KEY: 'secret-value-here',
        }),
      ),
    ).toThrow(/AWS_ACCESS_KEY_ID/);

    expect(() =>
      validateEnv(
        prodBase({
          STORAGE_DRIVER: 's3',
          S3_BUCKET: 'winger-uploads',
          S3_PUBLIC_BASE_URL: 'https://cdn.example.com',
          S3_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
          AWS_ACCESS_KEY_ID: 'key',
          AWS_SECRET_ACCESS_KEY: '',
        }),
      ),
    ).toThrow(/AWS_SECRET_ACCESS_KEY/);
  });

  it('8: allows local storage mode in production', () => {
    expect(() =>
      validateEnv(prodBase({ STORAGE_DRIVER: 'local' })),
    ).not.toThrow();
    expect(() => validateEnv(prodBase({ STORAGE_DRIVER: '' }))).not.toThrow();
  });

  it('9: development / demo mode skips strict validation', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'development',
        DATABASE_URL: '',
        JWT_SECRET: 'winger-dev-secret-change-me',
        STRIPE_SECRET_KEY: '',
      }),
    ).not.toThrow();
    expect(() => validateEnv({})).not.toThrow();
  });

  it('10: error messages never expose secret values', () => {
    const secretJwt = 'super-secret-jwt-value-should-not-leak-12345';
    const dbUrl =
      'postgresql://produser:VerySecretPassword@db.internal:5432/winger';
    const stripeSecret = 'sk_live_THIS_MUST_NOT_APPEAR_IN_ERRORS';
    try {
      validateEnv(
        prodBase({
          JWT_SECRET: 'winger-dev-secret-change-me',
          DATABASE_URL: dbUrl,
          STRIPE_SECRET_KEY: stripeSecret,
          STRIPE_WEBHOOK_SECRET: '',
        }),
      );
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const message = (error as Error).message;
      expect(message).not.toContain(secretJwt);
      expect(message).not.toContain('VerySecretPassword');
      expect(message).not.toContain(dbUrl);
      expect(message).not.toContain(stripeSecret);
      expect(message).not.toContain('THIS_MUST_NOT_APPEAR');
      expect(message).toContain('JWT_SECRET');
      expect(message).toContain('STRIPE_WEBHOOK_SECRET');
    }
  });

  it('11: does not require PAYMENT_RECONCILE_WORKER_ENABLED and allows it unset', () => {
    const env = prodBase();
    delete env.PAYMENT_RECONCILE_WORKER_ENABLED;
    expect(() => validateEnv(env)).not.toThrow();
    expect(env.PAYMENT_RECONCILE_WORKER_ENABLED).toBeUndefined();
  });

  it('does not require STRIPE_PUBLISHABLE_KEY on the API', () => {
    expect(() =>
      validateEnv(
        prodBase({
          STRIPE_SECRET_KEY: 'sk_test_exampleSecretKeyValue',
          STRIPE_WEBHOOK_SECRET: 'whsec_exampleWebhookSecret',
          PUBLIC_API_ORIGIN: 'https://api.example.com',
          STRIPE_PUBLISHABLE_KEY: '',
        }),
      ),
    ).not.toThrow();
  });

  it('applies production rules for case and whitespace variants of NODE_ENV', () => {
    for (const nodeEnv of [
      'Production',
      'PRODUCTION',
      ' production ',
      '\tProduction\n',
    ]) {
      expect(() =>
        validateEnv(prodBase({ NODE_ENV: nodeEnv, DATABASE_URL: '' })),
      ).toThrow(/DATABASE_URL/);
    }
  });

  it('rejects whitespace-only DATABASE_URL and JWT_SECRET', () => {
    expect(() => validateEnv(prodBase({ DATABASE_URL: ' \t\n ' }))).toThrow(
      /DATABASE_URL/,
    );
    expect(() => validateEnv(prodBase({ JWT_SECRET: ' \t\n ' }))).toThrow(
      /JWT_SECRET/,
    );
  });

  it('rejects a DATABASE_URL that is not a PostgreSQL URL', () => {
    expect(() =>
      validateEnv(
        prodBase({ DATABASE_URL: 'mysql://winger:winger@db:3306/winger' }),
      ),
    ).toThrow(/PostgreSQL URL/);
  });

  it('rejects an out-of-range or non-integer PORT and accepts the boundaries', () => {
    expect(() => validateEnv(prodBase({ PORT: '0' }))).toThrow(/PORT/);
    expect(() => validateEnv(prodBase({ PORT: '65536' }))).toThrow(/PORT/);
    expect(() => validateEnv(prodBase({ PORT: '3000abc' }))).toThrow(/PORT/);
    expect(() => validateEnv(prodBase({ PORT: '1' }))).not.toThrow();
    expect(() => validateEnv(prodBase({ PORT: '65535' }))).not.toThrow();
  });

  it('rejects an invalid Stripe secret prefix', () => {
    expect(() =>
      validateEnv(
        prodBase({
          STRIPE_SECRET_KEY: 'rk_live_not_a_stripe_secret_key',
          STRIPE_WEBHOOK_SECRET: 'whsec_exampleWebhookSecret',
          PUBLIC_API_ORIGIN: 'https://api.example.com',
        }),
      ),
    ).toThrow(/sk_test_ or sk_live_/);
  });

  it('rejects an HTTP or trailing-slash PUBLIC_API_ORIGIN when Stripe is configured', () => {
    const stripe = {
      STRIPE_SECRET_KEY: 'sk_test_exampleSecretKeyValue',
      STRIPE_WEBHOOK_SECRET: 'whsec_exampleWebhookSecret',
    };
    expect(() =>
      validateEnv(
        prodBase({ ...stripe, PUBLIC_API_ORIGIN: 'http://api.example.com' }),
      ),
    ).toThrow(/https URL/);
    expect(() =>
      validateEnv(
        prodBase({
          ...stripe,
          PUBLIC_API_ORIGIN: 'https://api.example.com/',
        }),
      ),
    ).toThrow(/no trailing slash/);
  });

  it('rejects a missing PUBLIC_API_ORIGIN when Stripe is configured', () => {
    expect(() =>
      validateEnv(
        prodBase({
          STRIPE_SECRET_KEY: 'sk_live_exampleSecretKeyValue',
          STRIPE_WEBHOOK_SECRET: 'whsec_exampleWebhookSecret',
          PUBLIC_API_ORIGIN: '',
        }),
      ),
    ).toThrow(/PUBLIC_API_ORIGIN is required/);
  });

  it('skips production-only validation when NODE_ENV=test', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'test',
        DATABASE_URL: '   ',
        JWT_SECRET: 'short',
        PORT: '0',
        STRIPE_SECRET_KEY: 'not-a-key',
      }),
    ).not.toThrow();
  });
});

describe('assertProductionEnvOrExit', () => {
  let exitSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit:${code ?? ''}`);
    });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('allows a valid production configuration to continue', () => {
    expect(() => assertProductionEnvOrExit(prodBase())).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('exits with status 1 when production configuration is invalid', () => {
    expect(() =>
      assertProductionEnvOrExit(prodBase({ DATABASE_URL: '' })),
    ).toThrow('process.exit:1');
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('DATABASE_URL');
  });

  it('does not exit for development or test environments', () => {
    assertProductionEnvOrExit({
      NODE_ENV: 'development',
      DATABASE_URL: '',
      JWT_SECRET: 'short',
    });
    assertProductionEnvOrExit({
      NODE_ENV: 'test',
      DATABASE_URL: '   ',
      JWT_SECRET: 'short',
      PORT: '0',
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('does not expose secret values when it reports a production failure', () => {
    const dbUrl =
      'postgresql://produser:VerySecretPassword@db.internal:5432/winger';
    const stripeSecret = 'sk_live_THIS_MUST_NOT_APPEAR_IN_ERRORS';

    expect(() =>
      assertProductionEnvOrExit(
        prodBase({
          JWT_SECRET: 'winger-dev-secret-change-me',
          DATABASE_URL: dbUrl,
          STRIPE_SECRET_KEY: stripeSecret,
          STRIPE_WEBHOOK_SECRET: '',
        }),
      ),
    ).toThrow('process.exit:1');

    const message = errorSpy.mock.calls
      .map((call) => String(call[0]))
      .join('\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(message).toContain('JWT_SECRET');
    expect(message).toContain('STRIPE_WEBHOOK_SECRET');
    expect(message).not.toContain('VerySecretPassword');
    expect(message).not.toContain(dbUrl);
    expect(message).not.toContain(stripeSecret);
    expect(message).not.toContain('THIS_MUST_NOT_APPEAR');
  });
});
