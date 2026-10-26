export const SEARCH_QUERY_MAX = 200;
export const SEARCH_RATE_LIMIT = 30;
export const SEARCH_RATE_WINDOW_MS = 60_000;

export type SearchFacets = {
  categories: string[];
  brands: string[];
  colors: string[];
  sizes: string[];
};

export type SearchInterpretation = {
  q: string;
  category?: string;
  brand?: string;
  color?: string;
  size?: string;
  minPrice?: number;
  maxPrice?: number;
  source: 'local' | 'ai' | 'keyword';
};

const SKIP_FACETS = new Set([
  'standard',
  'default',
  'one size',
  'onesize',
  'n/a',
  'na',
  '—',
  '-',
]);

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'for',
  'with',
  'in',
  'on',
  'to',
  'de',
  'la',
  'el',
  'los',
  'las',
  'un',
  'una',
  'ya',
  'na',
  'kwa',
  'ya',
  'under',
  'below',
  'less',
  'than',
  'over',
  'above',
  'from',
  'upto',
  'max',
  'maximum',
  'hasta',
  'menos',
  'mas',
  'más',
  'chini',
  'zaidi',
  'need',
  'needs',
  'needed',
  'want',
  'wants',
  'wanted',
  'looking',
  'look',
  'find',
  'get',
  'buy',
  'show',
  'me',
  'my',
  'some',
  'any',
  'something',
  'like',
  'please',
  'necesito',
  'busco',
  'quiero',
  'nataka',
  'ninataka',
]);

export function clipSearchQuery(value: string | undefined): string {
  return (value ?? '').trim().slice(0, SEARCH_QUERY_MAX);
}

export function keywordTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9áéíóúñü]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3 && !STOPWORDS.has(part));
}

export function pickFacet(
  value: string | null | undefined,
  names: string[],
): string | undefined {
  const raw = (value ?? '').trim();
  if (!raw) return undefined;
  const skip = SKIP_FACETS.has(raw.toLowerCase());
  if (skip) return undefined;
  const found = names.find((name) => name.toLowerCase() === raw.toLowerCase());
  return found;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function facetInQuery(query: string, names: string[]): { name?: string; rest: string } {
  const sorted = [...names]
    .filter((name) => name.trim().length >= 2 && !SKIP_FACETS.has(name.trim().toLowerCase()))
    .sort((a, b) => b.length - a.length);
  let rest = query;
  for (const name of sorted) {
    const pattern = new RegExp(`(?:^|\\s)${escapeRegex(name)}(?:\\s|$)`, 'i');
    if (pattern.test(rest)) {
      return { name, rest: rest.replace(pattern, ' ').replace(/\s+/g, ' ').trim() };
    }
  }
  return { rest };
}

function takePrice(
  query: string,
  pattern: RegExp,
): { amount?: number; rest: string } {
  const match = pattern.exec(query);
  if (!match) return { rest: query };
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000) {
    return { rest: query };
  }
  const rest = query.replace(match[0], ' ').replace(/\s+/g, ' ').trim();
  return { amount, rest };
}

export function interpretLocal(
  query: string,
  facets: SearchFacets,
): SearchInterpretation {
  let rest = clipSearchQuery(query);
  const max = takePrice(
    rest,
    /(?:under|below|less than|at most|max(?:imum)?|up to|menos de|hasta|chini ya)\s*\$?\s*(\d+(?:\.\d+)?)/i,
  );
  rest = max.rest;
  const min = takePrice(
    rest,
    /(?:over|above|at least|from|más de|mas de|zaidi ya)\s*\$?\s*(\d+(?:\.\d+)?)/i,
  );
  rest = min.rest;

  const category = facetInQuery(rest, facets.categories);
  rest = category.rest;
  const brand = facetInQuery(rest, facets.brands);
  rest = brand.rest;
  const color = facetInQuery(rest, facets.colors);
  rest = color.rest;
  const size = facetInQuery(rest, facets.sizes);
  rest = size.rest;

  return {
    q: rest,
    category: category.name,
    brand: brand.name,
    color: color.name,
    size: size.name,
    minPrice: min.amount,
    maxPrice: max.amount,
    source: 'local',
  };
}

export function parseAiInterpretation(
  raw: string,
  facets: SearchFacets,
): SearchInterpretation {
  const data = JSON.parse(raw) as Record<string, unknown>;
  const minPrice = Number(data.minPrice);
  const maxPrice = Number(data.maxPrice);
  return {
    q: clipSearchQuery(String(data.keywords ?? data.q ?? '')),
    category: pickFacet(String(data.category ?? ''), facets.categories),
    brand: pickFacet(String(data.brand ?? ''), facets.brands),
    color: pickFacet(String(data.color ?? ''), facets.colors),
    size: pickFacet(String(data.size ?? ''), facets.sizes),
    minPrice: Number.isFinite(minPrice) && minPrice >= 0 ? minPrice : undefined,
    maxPrice: Number.isFinite(maxPrice) && maxPrice >= 0 ? maxPrice : undefined,
    source: 'ai',
  };
}

export type SearchFilterInput = {
  q?: string;
  category?: string;
  brand?: string;
  supplierId?: string;
  color?: string;
  size?: string;
  minPrice?: number;
  maxPrice?: number;
  minRating?: number;
  inStock?: boolean;
  sort?: string;
  page?: number;
  pageSize?: number;
  maxMiles?: number;
  originCity?: string;
};

export function hasExtractedFilters(interpreted: SearchInterpretation): boolean {
  return Boolean(
    interpreted.category ||
      interpreted.brand ||
      interpreted.color ||
      interpreted.size ||
      interpreted.minPrice != null ||
      interpreted.maxPrice != null,
  );
}

export function mergeSearchFilters(
  client: SearchFilterInput,
  interpreted: SearchInterpretation,
): SearchFilterInput {
  return {
    ...client,
    q: interpreted.q || undefined,
    category: client.category?.trim() || interpreted.category,
    brand: client.brand?.trim() || interpreted.brand,
    color: client.color?.trim() || interpreted.color,
    size: client.size?.trim() || interpreted.size,
    minPrice: client.minPrice ?? interpreted.minPrice,
    maxPrice: client.maxPrice ?? interpreted.maxPrice,
  };
}

export class SearchRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit = SEARCH_RATE_LIMIT,
    private readonly windowMs = SEARCH_RATE_WINDOW_MS,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((time) => now - time < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
