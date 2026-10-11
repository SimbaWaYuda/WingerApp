import { milesBetween, resolvePlace } from './distance';

describe('distance', () => {
  const nairobi = resolvePlace('Nairobi');

  it('reads Kilimani out of a street address before the city', () => {
    expect(resolvePlace('Kilimani Street, Nairobi')).toEqual(resolvePlace('Kilimani'));
  });

  it('keeps nearby Nairobi hubs inside 10 miles and Nakuru outside 50', () => {
    expect(nairobi).not.toBeNull();
    const kijani = resolvePlace('Kilimani')!;
    const nakuru = resolvePlace('Nakuru')!;
    expect(milesBetween(nairobi!, kijani)).toBeLessThan(10);
    expect(milesBetween(nairobi!, nakuru)).toBeGreaterThan(50);
  });
});
