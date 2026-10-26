import {
  SearchRateLimiter,
  clipSearchQuery,
  hasExtractedFilters,
  interpretLocal,
  keywordTokens,
  mergeSearchFilters,
  parseAiInterpretation,
  pickFacet,
} from './search-interpret';

const facets = {
  categories: ['Audio', 'Home', 'Apparel'],
  brands: ['AeroPulse', 'Terraform'],
  colors: ['Graphite', 'Black', 'Navy'],
  sizes: ['Standard', 'M', 'L'],
};

describe('search interpretation', () => {
  it('extracts a USD budget and leftover keywords', () => {
    const result = interpretLocal('black office chair under $150', facets);
    expect(result.maxPrice).toBe(150);
    expect(result.color).toBe('Black');
    expect(result.q.toLowerCase()).toContain('office');
    expect(result.q.toLowerCase()).not.toContain('150');
    expect(result.source).toBe('local');
  });

  it('reads Spanish and Swahili budget phrases', () => {
    const chair = interpretLocal('silla menos de 80', facets);
    expect(chair.maxPrice).toBe(80);
    expect(chair.q.toLowerCase()).toContain('chair');
    expect(interpretLocal('kiti chini ya 200', facets).maxPrice).toBe(200);
  });

  it('maps Spanish and Kiswahili product words onto the English catalogue', () => {
    expect(keywordTokens('necesito un reloj')).toEqual(['watch']);
    expect(keywordTokens('nataka saa')).toEqual(['watch']);
    expect(keywordTokens('busco auriculares')).toEqual(['headphones']);
    expect(interpretLocal('hogar', facets).category).toBe('Home');
    expect(interpretLocal('lampara negra', facets).color).toBe('Black');
    const clothes = interpretLocal('nataka nguo', facets);
    expect(clothes.clothing).toBe(true);
    expect(clothes.category).toBeUndefined();
    expect(clothes.q).toBe('');
    expect(interpretLocal('ropa', facets).clothing).toBe(true);
    expect(interpretLocal('chaqueta', facets).q.toLowerCase()).toContain('jacket');
    expect(interpretLocal('chaqueta', facets).clothing).toBeUndefined();
  });

  it('keeps an exact product name as keywords', () => {
    const result = interpretLocal('AeroPulse', facets);
    expect(result.brand).toBe('AeroPulse');
    expect(result.maxPrice).toBeUndefined();
    expect(hasExtractedFilters(result)).toBe(true);
    expect(hasExtractedFilters({ q: 'AeroPulse', source: 'keyword' })).toBe(false);
  });

  it('lets a client chip win over interpretation', () => {
    const interpreted = interpretLocal('navy lamp under $40', facets);
    const merged = mergeSearchFilters(
      { color: 'Graphite', maxPrice: 100 },
      interpreted,
    );
    expect(merged.color).toBe('Graphite');
    expect(merged.maxPrice).toBe(100);
  });

  it('accepts only facet values from the AI JSON', () => {
    const parsed = parseAiInterpretation(
      JSON.stringify({
        category: 'Spaceships',
        color: 'Black',
        maxPrice: 150,
        keywords: 'chair',
      }),
      facets,
    );
    expect(parsed.category).toBeUndefined();
    expect(parsed.color).toBe('Black');
    expect(parsed.maxPrice).toBe(150);
    expect(parsed.q).toBe('chair');
    expect(parsed.source).toBe('ai');
  });

  it('clips long queries and skips generic sizes', () => {
    expect(clipSearchQuery('x'.repeat(250)).length).toBe(200);
    expect(pickFacet('Standard', facets.sizes)).toBeUndefined();
    expect(keywordTokens('the black office chair')).toEqual(['black', 'office', 'chair']);
    expect(keywordTokens('need a watch')).toEqual(['watch']);
    expect(keywordTokens('audífonos')).toEqual(['headphones']);
  });

  it('rate-limits a noisy client', () => {
    const limiter = new SearchRateLimiter(2, 60_000);
    expect(limiter.allow('ip-1')).toBe(true);
    expect(limiter.allow('ip-1')).toBe(true);
    expect(limiter.allow('ip-1')).toBe(false);
    expect(limiter.allow('ip-2')).toBe(true);
  });
});
