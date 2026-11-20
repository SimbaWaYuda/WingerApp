import { isProductionEnv } from './env-mode';

describe('env-mode', () => {
  it('treats only NODE_ENV=production as production', () => {
    expect(isProductionEnv({ NODE_ENV: 'production' })).toBe(true);
    expect(isProductionEnv({ NODE_ENV: 'Production' })).toBe(true);
    expect(isProductionEnv({ NODE_ENV: 'development' })).toBe(false);
    expect(isProductionEnv({})).toBe(false);
  });

  it('treats production detection as case-insensitive and trims whitespace', () => {
    expect(isProductionEnv({ NODE_ENV: 'PRODUCTION' })).toBe(true);
    expect(isProductionEnv({ NODE_ENV: ' Production ' })).toBe(true);
    expect(isProductionEnv({ NODE_ENV: '\tproduction\n' })).toBe(true);
  });

  it('does not treat unset, empty, or non-production values as production', () => {
    expect(isProductionEnv({})).toBe(false);
    expect(isProductionEnv({ NODE_ENV: '' })).toBe(false);
    expect(isProductionEnv({ NODE_ENV: '   ' })).toBe(false);
    expect(isProductionEnv({ NODE_ENV: 'prod' })).toBe(false);
    expect(isProductionEnv({ NODE_ENV: 'staging' })).toBe(false);
  });
});
