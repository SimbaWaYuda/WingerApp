import { ProductSearchIndexService } from './product-search-index.service';
import { buildSearchDocument, hashSearchContent } from './search-document';

describe('ProductSearchIndexService', () => {
  it('rewrites searchText when a supplier updates the listing', async () => {
    const updates: Array<{ searchText: string }> = [];
    const prisma = {
      product: {
        update: jest.fn(async ({ data }) => {
          updates.push(data);
          return data;
        }),
      },
      productSearchEmbedding: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
      },
    };
    const service = new ProductSearchIndexService(prisma as never);
    service.bindEmbedder(null);
    const before = {
      id: 'p-kitanda-mbao',
      name: 'Kitanda cha Mbao Imara',
      brand: 'Atlas Home',
      category: 'Home',
      color: 'Oak',
      size: 'Queen',
      model: 'KM-1',
      description: 'Kitanda imara cha mbao.',
    };
    const after = {
      ...before,
      description: 'Kitanda imara cha mbao na magurudumu.',
    };
    await service.refresh(before);
    await service.refresh(after);
    expect(updates[0].searchText).toBe(buildSearchDocument(before));
    expect(updates[1].searchText).toBe(buildSearchDocument(after));
    expect(updates[0].searchText).not.toBe(updates[1].searchText);
    expect(hashSearchContent(before)).not.toBe(hashSearchContent(after));
  });

  it('returns no semantic ids when the embedder times out', async () => {
    const prisma = {
      productSearchEmbedding: { findMany: jest.fn() },
    };
    const service = new ProductSearchIndexService(prisma as never);
    service.bindEmbedder({
      model: 'timeout',
      embed: async () => {
        throw new Error('aborted');
      },
    });
    await expect(service.similar('kitanda')).resolves.toEqual([]);
    expect(prisma.productSearchEmbedding.findMany).not.toHaveBeenCalled();
  });
});
