import { HttpException } from '@nestjs/common';
import { ProductsSearchService } from './products-search.service';

function facets() {
  return {
    listCategories: jest.fn().mockResolvedValue([{ name: 'Home', productCount: 1 }]),
    listBrands: jest.fn().mockResolvedValue([{ name: 'Atlas', productCount: 1 }]),
    listColors: jest.fn().mockResolvedValue([{ name: 'Black', productCount: 1 }]),
    listSizes: jest.fn().mockResolvedValue([{ name: 'M', productCount: 1 }]),
    browse: jest.fn().mockImplementation(async (query) => ({
      items: query.maxPrice != null && query.maxPrice < 10 ? [] : [{ id: 'p-chair', price: 120 }],
      total: query.maxPrice != null && query.maxPrice < 10 ? 0 : 1,
      page: 1,
      pageSize: 24,
      totalPages: 1,
    })),
  };
}

describe('ProductsSearchService', () => {
  const previousKey = process.env.SEARCH_AI_API_KEY;

  afterEach(() => {
    if (previousKey === undefined) delete process.env.SEARCH_AI_API_KEY;
    else process.env.SEARCH_AI_API_KEY = previousKey;
  });

  it('applies a local budget and returns catalogue ids from browse', async () => {
    delete process.env.SEARCH_AI_API_KEY;
    const products = facets();
    const service = new ProductsSearchService(products as never);
    const result = await service.search(
      { q: 'black office chair under $150', page: 1, pageSize: 24 },
      'tester',
    );
    expect(products.browse).toHaveBeenCalledWith(
      expect.objectContaining({ maxPrice: 150, color: 'Black' }),
    );
    expect(result.items[0].id).toBe('p-chair');
    expect(result.interpretation.maxPrice).toBe(150);
  });

  it('falls back to keyword browse when the AI provider fails', async () => {
    process.env.SEARCH_AI_API_KEY = 'sk-test-search';
    const products = facets();
    const service = new ProductsSearchService(products as never);
    service.bindFetch(async () => {
      throw new Error('network down');
    });
    const result = await service.search({ q: 'AeroPulse headphones' }, 'tester-ai');
    expect(products.browse).toHaveBeenCalled();
    expect(result.items[0].id).toBe('p-chair');
  });

  it('uses AI filters only when they match real facets', async () => {
    process.env.SEARCH_AI_API_KEY = 'sk-test-search';
    const products = facets();
    const service = new ProductsSearchService(products as never);
    service.bindFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                category: 'Home',
                color: 'Unicorn',
                maxPrice: 90,
                keywords: 'lamp',
              }),
            },
          },
        ],
      }),
    }));
    await service.search({ q: 'cheap lamp' }, 'tester-ai-ok');
    expect(products.browse).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'Home',
        maxPrice: 90,
        q: 'lamp',
      }),
    );
    const query = products.browse.mock.calls[0][0];
    expect(query.color).toBeUndefined();
  });

  it('asks browse for every clothing match when the query is nguo', async () => {
    delete process.env.SEARCH_AI_API_KEY;
    const products = facets();
    const service = new ProductsSearchService(products as never);
    await service.search({ q: 'nataka nguo' }, 'tester-nguo');
    expect(products.browse).toHaveBeenCalledWith(
      expect.objectContaining({ clothing: true }),
    );
    const query = products.browse.mock.calls[0][0];
    expect(query.category).toBeUndefined();
  });

  it('returns an empty page when nothing matches', async () => {
    delete process.env.SEARCH_AI_API_KEY;
    const products = facets();
    const service = new ProductsSearchService(products as never);
    const result = await service.search({ q: 'chair under $5' }, 'tester-empty');
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('rejects an oversized query', async () => {
    const products = facets();
    const service = new ProductsSearchService(products as never);
    await expect(service.search({ q: 'chair '.repeat(80) }, 'tester-long')).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(products.browse).not.toHaveBeenCalled();
  });
});
