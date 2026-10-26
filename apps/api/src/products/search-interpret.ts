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
  /** Apparel + Clothes + dress/jacket products, not one category chip. */
  clothing?: boolean;
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
  'quisiera',
  'estoy',
  'buscando',
  'comprar',
  'ver',
  'dame',
  'algo',
  'este',
  'esta',
  'estos',
  'estas',
  'del',
  'para',
  'por',
  'con',
  'que',
  'como',
  'unos',
  'unas',
  'nataka',
  'ninataka',
  'tafuta',
  'tafadhali',
  'naomba',
  'kitu',
  'nipatie',
  'nione',
  'nitafute',
  'cha',
  'vya',
]);

/** Spanish / Kiswahili shopping words → English catalogue tokens. */
const SYNONYMS: Record<string, string> = {
  reloj: 'watch',
  relojes: 'watch',
  saa: 'watch',
  masaa: 'watch',
  smartwatch: 'watch',
  auriculares: 'headphones',
  audifonos: 'headphones',
  cascos: 'headphones',
  altavoz: 'speaker',
  altavoces: 'speaker',
  parlante: 'speaker',
  spika: 'speaker',
  kipaza: 'speaker',
  sauti: 'audio',
  sonido: 'audio',
  silla: 'chair',
  sillas: 'chair',
  kiti: 'chair',
  viti: 'chair',
  lampara: 'lamp',
  lamparas: 'lamp',
  taa: 'lamp',
  mochila: 'bag',
  bolso: 'bag',
  bolsa: 'bag',
  bolsos: 'bag',
  mkoba: 'bag',
  mifuko: 'bag',
  begi: 'bag',
  chaqueta: 'jacket',
  chamarra: 'jacket',
  abrigo: 'jacket',
  koti: 'jacket',
  jaketi: 'jacket',
  ropa: 'clothes',
  prenda: 'clothes',
  prendas: 'clothes',
  nguo: 'clothes',
  mavazi: 'clothes',
  hogar: 'home',
  mueble: 'home',
  nyumbani: 'home',
  nyumba: 'home',
  electronico: 'electronic',
  electronicos: 'electronic',
  elektroniki: 'electronic',
  cocina: 'kitchen',
  negro: 'black',
  negra: 'black',
  negros: 'black',
  negras: 'black',
  nyeusi: 'black',
  blanco: 'white',
  blanca: 'white',
  nyeupe: 'white',
  azul: 'navy',
  marino: 'navy',
  grafito: 'graphite',
  oficina: 'office',
  ofisi: 'office',
  escritorio: 'desk',
  dawati: 'desk',
};

const CLOTHING_UMBRELLA = new Set([
  'clothes',
  'clothing',
  'apparel',
  'ropa',
  'prenda',
  'prendas',
  'nguo',
  'mavazi',
]);

export const CLOTHING_CATEGORY_NAMES = ['Apparel', 'Clothes', 'Clothing'];

export const GARMENT_TOKENS = [
  'dress',
  'jacket',
  'gown',
  'shirt',
  'pant',
  'blouse',
  'skirt',
  'coat',
  'outfit',
  'dashiki',
  'kente',
  'apparel',
  'clothes',
];

function foldWord(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function expandWord(word: string): string {
  const folded = foldWord(word);
  return SYNONYMS[folded] ?? folded;
}

export function isClothingUmbrellaToken(token: string): boolean {
  const folded = foldWord(token);
  return CLOTHING_UMBRELLA.has(folded) || CLOTHING_UMBRELLA.has(SYNONYMS[folded] ?? '');
}

export function expandSearchQuery(query: string): string {
  return query.replace(/[a-z0-9áéíóúñü]+/gi, (word) => {
    const folded = foldWord(word);
    if (folded.length < 3 || STOPWORDS.has(folded)) return word;
    return SYNONYMS[folded] ?? word;
  });
}

export function clipSearchQuery(value: string | undefined): string {
  return (value ?? '').trim().slice(0, SEARCH_QUERY_MAX);
}

export function keywordTokens(query: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of query.toLowerCase().split(/[^a-z0-9áéíóúñü]+/i)) {
    const folded = foldWord(part.trim());
    if (folded.length < 3 || STOPWORDS.has(folded)) continue;
    const mapped = expandWord(folded);
    if (mapped.length < 3 || STOPWORDS.has(mapped) || seen.has(mapped)) continue;
    seen.add(mapped);
    tokens.push(mapped);
  }
  return tokens;
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

function takeClothingUmbrella(query: string): { clothing: boolean; rest: string } {
  let clothing = false;
  const rest = query
    .replace(/[a-z0-9áéíóúñü]+/gi, (word) => {
      const folded = foldWord(word);
      if (CLOTHING_UMBRELLA.has(folded) || CLOTHING_UMBRELLA.has(SYNONYMS[folded] ?? '')) {
        clothing = true;
        return ' ';
      }
      return word;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { clothing, rest };
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
  let rest = expandSearchQuery(clipSearchQuery(query));
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

  const clothing = takeClothingUmbrella(rest);
  rest = clothing.rest;

  const category = facetInQuery(rest, facets.categories);
  rest = category.rest;
  const brand = facetInQuery(rest, facets.brands);
  rest = brand.rest;
  const color = facetInQuery(rest, facets.colors);
  rest = color.rest;
  const size = facetInQuery(rest, facets.sizes);
  rest = size.rest;

  return {
    q: keywordTokens(rest).join(' '),
    category: category.name,
    brand: brand.name,
    color: color.name,
    size: size.name,
    minPrice: min.amount,
    maxPrice: max.amount,
    clothing: clothing.clothing || undefined,
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
  clothing?: boolean;
};

export function hasExtractedFilters(interpreted: SearchInterpretation): boolean {
  return Boolean(
    interpreted.category ||
      interpreted.brand ||
      interpreted.color ||
      interpreted.size ||
      interpreted.minPrice != null ||
      interpreted.maxPrice != null ||
      interpreted.clothing,
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
    clothing: client.category?.trim() ? undefined : interpreted.clothing,
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
