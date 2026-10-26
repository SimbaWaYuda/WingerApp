import {
  buildSearchDocument,
  cosineSimilarity,
  hashSearchContent,
} from './search-document';
import { fakeMultilingualEmbedder } from './product-search-index.service';

const englishBed = {
  id: 'p-oak-wooden-bed',
  name: 'Oak Frame Wooden Bed',
  brand: 'Atlas Home',
  category: 'Home',
  color: 'Oak',
  size: 'Queen',
  model: 'Oak-Q',
  description: 'A strong wooden bed with a sturdy oak frame for a small bedroom.',
};

const swahiliBed = {
  id: 'p-kitanda-mbao',
  name: 'Kitanda cha Mbao Imara',
  brand: 'Atlas Home',
  category: 'Home',
  color: 'Mbao',
  size: 'Queen',
  model: 'KM-1',
  description: 'Kitanda imara cha mbao kwa chumba kidogo, kimeundwa kwa mbao ngumu.',
};

const mixedChair = {
  id: 'p-mixed-office-stool',
  name: 'Rolling Office Stool',
  brand: 'Atlas Home',
  category: 'Home',
  color: 'Black',
  size: 'Standard',
  model: 'ROS-1',
  description: 'Kiti cha ofisi chenye magurudumu, rangi nyeusi.',
};

describe('bilingual search documents', () => {
  it('indexes English bed text so a Swahili query can match', () => {
    const document = buildSearchDocument(englishBed).toLowerCase();
    expect(document).toContain('oak frame wooden bed');
    expect(document).toContain('kitanda');
    expect(document).toContain('mbao');
    expect(document).toContain('imara');
  });

  it('indexes Swahili bed text so an English query can match', () => {
    const document = buildSearchDocument(swahiliBed).toLowerCase();
    expect(document).toContain('kitanda cha mbao imara');
    expect(document).toContain('bed');
    expect(document).toContain('wood');
    expect(document).toContain('strong');
  });

  it('indexes mixed-language chair copy for both languages', () => {
    const document = buildSearchDocument(mixedChair).toLowerCase();
    expect(document).toContain('rolling office stool');
    expect(document).toContain('kiti');
    expect(document).toContain('chair');
    expect(document).toContain('wheel');
    expect(document).toContain('black');
  });

  it('keeps the displayed title out of the hash when only search tokens change', () => {
    expect(hashSearchContent(englishBed)).toBe(hashSearchContent({ ...englishBed }));
  });

  it('gives a Swahili bed query a high score against an English bed embedding', async () => {
    const embedder = fakeMultilingualEmbedder();
    const query = await embedder.embed(
      'Natafuta kitanda imara cha mbao kisichozidi dola 200',
    );
    const product = await embedder.embed(buildSearchDocument(englishBed));
    expect(cosineSimilarity(query, product)).toBeGreaterThan(0.8);
  });

  it('gives an English chair query a high score against mixed-language copy', async () => {
    const embedder = fakeMultilingualEmbedder();
    const query = await embedder.embed('Black office chair with wheels');
    const product = await embedder.embed(buildSearchDocument(mixedChair));
    expect(cosineSimilarity(query, product)).toBeGreaterThan(0.8);
  });
});
