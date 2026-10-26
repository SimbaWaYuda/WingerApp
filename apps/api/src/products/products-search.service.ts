import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ProductSearchIndexService } from './product-search-index.service';
import {
  ProductBrowseQuery,
  ProductBrowseResult,
  ProductsService,
} from './products.service';
import {
  SEARCH_QUERY_MAX,
  SearchFacets,
  SearchFilterInput,
  SearchInterpretation,
  SearchRateLimiter,
  clipSearchQuery,
  hasExtractedFilters,
  interpretLocal,
  mergeSearchFilters,
  parseAiInterpretation,
} from './search-interpret';

export type ProductSearchBody = SearchFilterInput & {
  locale?: string;
};

export type ProductSearchResult = ProductBrowseResult & {
  interpretation: SearchInterpretation;
};

type ChatFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

@Injectable()
export class ProductsSearchService {
  private readonly logger = new Logger(ProductsSearchService.name);
  private readonly limiter = new SearchRateLimiter();

  constructor(
    private readonly products: ProductsService,
    private readonly searchIndex: ProductSearchIndexService,
  ) {}

  private fetchImpl: ChatFetch = fetch as ChatFetch;

  /** Test hook. Production uses global fetch. */
  bindFetch(fetchImpl: ChatFetch) {
    this.fetchImpl = fetchImpl;
  }

  async search(body: ProductSearchBody, clientKey: string): Promise<ProductSearchResult> {
    const q = clipSearchQuery(body.q);
    if ((body.q ?? '').trim().length > SEARCH_QUERY_MAX) {
      throw new HttpException('Search is too long', HttpStatus.BAD_REQUEST);
    }
    if (q && !this.limiter.allow(clientKey || 'anon')) {
      throw new HttpException('Too many searches', HttpStatus.TOO_MANY_REQUESTS);
    }

    const client: ProductBrowseQuery = {
      ...body,
      q: q || undefined,
    };

    if (!q) {
      const page = await this.products.browse(client);
      return { ...page, interpretation: { q: '', source: 'keyword' } };
    }

    const facets = await this.loadFacets();
    let interpreted = interpretLocal(q, facets);
    let filters = mergeSearchFilters(client, interpreted);

    if (this.aiConfigured() && interpreted.q) {
      try {
        const ai = await this.interpretWithAi(q, facets, body.locale);
        interpreted = {
          ...interpreted,
          ...ai,
          q: ai.q || interpreted.q,
          source: 'ai',
        };
        filters = mergeSearchFilters(client, interpreted);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'ai search failed';
        this.logger.warn(`AI search fallback: ${message}`);
      }
    } else if (!this.aiConfigured() && !hasExtractedFilters(interpreted)) {
      interpreted = { q, source: 'keyword' };
      filters = { ...client, q };
    }

    let semanticIds: string[] = [];
    if (q) {
      try {
        semanticIds = await this.searchIndex.similar(q);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'semantic search failed';
        this.logger.warn(`Semantic search fallback: ${message}`);
      }
    }
    const page = await this.products.browse({
      ...filters,
      semanticIds: semanticIds.length ? semanticIds : undefined,
    });
    return { ...page, interpretation: interpreted };
  }

  private async loadFacets(): Promise<SearchFacets> {
    const [categories, brands, colors, sizes] = await Promise.all([
      this.products.listCategories(),
      this.products.listBrands(),
      this.products.listColors(),
      this.products.listSizes(),
    ]);
    return {
      categories: categories.map((row) => row.name),
      brands: brands.map((row) => row.name),
      colors: colors.map((row) => row.name),
      sizes: sizes.map((row) => row.name),
    };
  }

  private aiConfigured(): boolean {
    return Boolean(process.env.SEARCH_AI_API_KEY?.trim());
  }

  private async interpretWithAi(
    query: string,
    facets: SearchFacets,
    locale?: string,
  ): Promise<SearchInterpretation> {
    const key = process.env.SEARCH_AI_API_KEY?.trim() ?? '';
    const base = (process.env.SEARCH_AI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(
      /\/$/,
      '',
    );
    const model = process.env.SEARCH_AI_MODEL?.trim() || 'gpt-4o-mini';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await this.fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'Extract shopping filters from the customer query. Query language may be English, Spanish, or Swahili. Return JSON only: {"category":string|null,"brand":string|null,"color":string|null,"size":string|null,"minPrice":number|null,"maxPrice":number|null,"keywords":string}. category, brand, color, and size must be one of the provided lists or null. Prices are USD numbers. keywords are leftover search words. Do not invent products.',
            },
            {
              role: 'user',
              content: JSON.stringify({
                query,
                locale: locale || 'en',
                categories: facets.categories,
                brands: facets.brands,
                colors: facets.colors,
                sizes: facets.sizes,
              }),
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`AI HTTP ${response.status}`);
      }
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content ?? '{}';
      return parseAiInterpretation(content, facets);
    } finally {
      clearTimeout(timer);
    }
  }
}
