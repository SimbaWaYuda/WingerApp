export type GeoPoint = { lat: number; lng: number };

const PLACES: Record<string, GeoPoint> = {
  kilimani: { lat: -1.2921, lng: 36.787 },
  westlands: { lat: -1.2674, lng: 36.811 },
  kitengela: { lat: -1.477, lng: 36.96 },
  nakuru: { lat: -0.3031, lng: 36.08 },
  mombasa: { lat: -4.0435, lng: 39.6682 },
  nairobi: { lat: -1.286389, lng: 36.817223 },
};

/** Match a city or address to a known place. Longer names win, so Kilimani beats Nairobi. */
export function resolvePlace(text: string | null | undefined): GeoPoint | null {
  const raw = (text ?? '').trim().toLowerCase();
  if (!raw) return null;
  const keys = Object.keys(PLACES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (raw === key || raw.includes(key)) return PLACES[key];
  }
  return null;
}

/** Great-circle distance in miles. */
export function milesBetween(from: GeoPoint, to: GeoPoint): number {
  const earthMiles = 3958.8;
  const dLat = toRadians(to.lat - from.lat);
  const dLng = toRadians(to.lng - from.lng);
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthMiles * Math.asin(Math.min(1, Math.sqrt(h)));
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
