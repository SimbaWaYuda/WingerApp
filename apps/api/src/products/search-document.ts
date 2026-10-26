import { createHash } from 'crypto';

/** First token is the English catalogue form. */
export const TOKEN_CLUSTERS: string[][] = [
  ['watch', 'saa', 'masaa', 'reloj', 'relojes', 'smartwatch'],
  ['headphones', 'auriculares', 'audifonos', 'cascos'],
  ['speaker', 'altavoz', 'altavoces', 'parlante', 'spika', 'kipaza'],
  ['audio', 'sauti', 'sonido'],
  ['chair', 'kiti', 'viti', 'silla', 'sillas'],
  ['bed', 'kitanda', 'vitanda'],
  ['wood', 'wooden', 'mbao'],
  ['strong', 'imara', 'ngumu', 'sturdy'],
  ['wheel', 'wheels', 'magurudumu'],
  ['lamp', 'taa', 'lampara', 'lamparas'],
  ['bag', 'mochila', 'bolso', 'bolsa', 'bolsos', 'mkoba', 'mifuko', 'begi', 'pack'],
  ['jacket', 'chaqueta', 'chamarra', 'abrigo', 'koti', 'jaketi'],
  ['clothes', 'clothing', 'ropa', 'prenda', 'prendas', 'nguo', 'mavazi'],
  ['home', 'hogar', 'mueble', 'nyumbani', 'nyumba'],
  ['electronic', 'electronico', 'electronicos', 'elektroniki'],
  ['kitchen', 'cocina'],
  ['black', 'negro', 'negra', 'negros', 'negras', 'nyeusi', 'cheusi'],
  ['white', 'blanco', 'blanca', 'nyeupe'],
  ['navy', 'azul', 'marino'],
  ['graphite', 'grafito'],
  ['office', 'oficina', 'ofisi'],
  ['desk', 'escritorio', 'dawati'],
  ['dress', 'dresses', 'gauni', 'gown', 'gowns'],
];

const CANONICAL: Record<string, string> = {};
const CLUSTER_BY_TOKEN = new Map<string, string[]>();
for (const cluster of TOKEN_CLUSTERS) {
  for (const token of cluster) {
    CANONICAL[token] = cluster[0];
    CLUSTER_BY_TOKEN.set(token, cluster);
  }
}

export function foldWord(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function canonicalToken(word: string): string {
  const folded = foldWord(word);
  return CANONICAL[folded] ?? folded;
}

export function clusterFor(word: string): string[] {
  const folded = foldWord(word);
  return CLUSTER_BY_TOKEN.get(folded) ?? [folded];
}

export type SearchableProduct = {
  id: string;
  name: string;
  brand: string;
  category: string;
  color: string;
  size: string;
  model: string;
  description: string;
  extraSpecs?: { label: string; value: string }[];
};

export function searchableSource(product: SearchableProduct): string {
  const specs = (product.extraSpecs ?? [])
    .flatMap((row) => [row.label, row.value])
    .join(' ');
  return [
    product.id,
    product.name,
    product.brand,
    product.category,
    product.color,
    product.size,
    product.model,
    product.description,
    specs,
  ]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildSearchDocument(product: SearchableProduct): string {
  const source = searchableSource(product);
  const tokens = new Set<string>();
  for (const part of source.toLowerCase().split(/[^a-z0-9áéíóúñü]+/i)) {
    const folded = foldWord(part.trim());
    if (folded.length < 2) continue;
    tokens.add(folded);
    for (const extra of clusterFor(folded)) {
      tokens.add(extra);
    }
  }
  return `${source} ${[...tokens].join(' ')}`.replace(/\s+/g, ' ').trim();
}

export function hashSearchContent(product: SearchableProduct): string {
  return createHash('sha256').update(searchableSource(product)).digest('hex');
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
