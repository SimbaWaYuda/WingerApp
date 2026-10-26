import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  SearchableProduct,
  buildSearchDocument,
  cosineSimilarity,
  hashSearchContent,
} from './search-document';

export type SearchEmbedder = {
  model: string;
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
};

type CachedVector = { vector: number[]; at: number };

const QUERY_CACHE_MS = 60_000;
const EMBED_TIMEOUT_MS = 4_000;
const SEMANTIC_LIMIT = 24;
const SEMANTIC_MIN_SCORE = 0.78;

@Injectable()
export class ProductSearchIndexService implements OnModuleInit {
  private readonly logger = new Logger(ProductSearchIndexService.name);
  private embedder: SearchEmbedder | null = null;
  private readonly queryCache = new Map<string, CachedVector>();
  private fetchImpl = fetch;

  constructor(private readonly prisma: PrismaService) {
    if (process.env.SEARCH_AI_API_KEY?.trim()) {
      this.embedder = this.openAiEmbedder();
    }
  }

  bindEmbedder(embedder: SearchEmbedder | null) {
    this.embedder = embedder;
  }

  bindFetch(fetchImpl: typeof fetch) {
    this.fetchImpl = fetchImpl;
    if (process.env.SEARCH_AI_API_KEY?.trim()) {
      this.embedder = this.openAiEmbedder();
    }
  }

  async onModuleInit() {
    await this.backfill().catch((error) => {
      const message = error instanceof Error ? error.message : 'backfill failed';
      this.logger.warn(`Search index backfill: ${message}`);
    });
  }

  async refresh(product: SearchableProduct): Promise<void> {
    const searchText = buildSearchDocument(product);
    const contentHash = hashSearchContent(product);
    await this.prisma.product.update({
      where: { id: product.id },
      data: { searchText },
    });
    await this.refreshEmbedding(product.id, searchText, contentHash);
  }

  async similar(query: string): Promise<string[]> {
    if (!this.embedder || !query.trim()) return [];
    try {
      const vector = await this.embedQuery(query);
      const rows = await this.prisma.productSearchEmbedding.findMany();
      return rows
        .map((row) => ({
          id: row.productId,
          score: cosineSimilarity(vector, asNumberArray(row.vector)),
        }))
        .filter((row) => row.score >= SEMANTIC_MIN_SCORE)
        .sort((a, b) => b.score - a.score)
        .slice(0, SEMANTIC_LIMIT)
        .map((row) => row.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'embed failed';
      this.logger.warn(`Semantic search fallback: ${message}`);
      return [];
    }
  }

  async backfill(): Promise<void> {
    const products = await this.prisma.product.findMany({
      select: {
        id: true,
        name: true,
        brand: true,
        category: true,
        color: true,
        size: true,
        model: true,
        description: true,
        extraSpecs: true,
        searchText: true,
      },
    });
    for (const product of products) {
      const searchable = toSearchable(product);
      const searchText = buildSearchDocument(searchable);
      if (product.searchText !== searchText) {
        await this.prisma.product.update({
          where: { id: product.id },
          data: { searchText },
        });
      }
      await this.refreshEmbedding(
        product.id,
        searchText,
        hashSearchContent(searchable),
      );
    }
  }

  private async refreshEmbedding(
    productId: string,
    searchText: string,
    contentHash: string,
  ) {
    if (!this.embedder) return;
    const existing = await this.prisma.productSearchEmbedding.findUnique({
      where: { productId },
    });
    if (
      existing &&
      existing.contentHash === contentHash &&
      existing.model === this.embedder.model
    ) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    try {
      const vector = await this.embedder.embed(searchText, controller.signal);
      await this.prisma.productSearchEmbedding.upsert({
        where: { productId },
        update: { vector, contentHash, model: this.embedder.model },
        create: {
          productId,
          vector,
          contentHash,
          model: this.embedder.model,
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async embedQuery(query: string): Promise<number[]> {
    const key = `${this.embedder?.model}:${query}`;
    const cached = this.queryCache.get(key);
    if (cached && Date.now() - cached.at < QUERY_CACHE_MS) {
      return cached.vector;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    try {
      const vector = await this.embedder!.embed(query, controller.signal);
      this.queryCache.set(key, { vector, at: Date.now() });
      return vector;
    } finally {
      clearTimeout(timer);
    }
  }

  private openAiEmbedder(): SearchEmbedder {
    const key = process.env.SEARCH_AI_API_KEY?.trim() ?? '';
    const base = (process.env.SEARCH_AI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(
      /\/$/,
      '',
    );
    const model =
      process.env.SEARCH_EMBED_MODEL?.trim() || 'text-embedding-3-small';
    return {
      model,
      embed: async (text, signal) => {
        const response = await this.fetchImpl(`${base}/embeddings`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            input: text.slice(0, 8_000),
          }),
          signal,
        });
        if (!response.ok) {
          throw new Error(`Embed HTTP ${response.status}`);
        }
        const payload = (await response.json()) as {
          data?: Array<{ embedding?: number[] }>;
        };
        const vector = payload.data?.[0]?.embedding;
        if (!vector?.length) throw new Error('empty embedding');
        return vector;
      },
    };
  }
}

export function fakeMultilingualEmbedder(): SearchEmbedder {
  return {
    model: 'fake-en-sw',
    embed: async (text) => {
      const t = text.toLowerCase();
      const vector = [
        /bed|kitanda/.test(t) ? 1 : 0,
        /wood|wooden|mbao/.test(t) ? 1 : 0,
        /chair|kiti|silla/.test(t) ? 1 : 0,
        /wheel|wheels|magurudumu/.test(t) ? 1 : 0,
        /black|cheusi|nyeusi|negro/.test(t) ? 1 : 0,
        /watch|saa|reloj/.test(t) ? 1 : 0,
        /office|ofisi|oficina/.test(t) ? 1 : 0,
        /strong|imara|sturdy/.test(t) ? 1 : 0,
      ];
      return vector;
    },
  };
}

function toSearchable(product: {
  id: string;
  name: string;
  brand: string;
  category: string;
  color: string;
  size: string;
  model: string;
  description: string;
  extraSpecs: Prisma.JsonValue;
}): SearchableProduct {
  const extraSpecs = Array.isArray(product.extraSpecs)
    ? product.extraSpecs.flatMap((row) => {
        if (!row || typeof row !== 'object') return [];
        const label = String((row as { label?: unknown }).label ?? '').trim();
        const value = String((row as { value?: unknown }).value ?? '').trim();
        return label && value ? [{ label, value }] : [];
      })
    : [];
  return { ...product, extraSpecs };
}

function asNumberArray(value: Prisma.JsonValue): number[] {
  return Array.isArray(value) ? value.map((item) => Number(item) || 0) : [];
}
