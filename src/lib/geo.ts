import type { GeoPolygon } from "./types";

type Ring = number[][]; // [lon, lat][]

/** 외곽 링 목록 (구멍은 무시) */
export function outerRings(p: GeoPolygon): Ring[] {
  return p.type === "Polygon" ? [p.coordinates[0]] : p.coordinates.map((poly) => poly[0]);
}

export function bbox(p: GeoPolygon): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of outerRings(p)) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}

function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function containsPoint(p: GeoPolygon, lon: number, lat: number): boolean {
  return outerRings(p).some((ring) => inRing(lon, lat, ring));
}

/** 상가정보 API 요청 길이를 줄이기 위해 꼭짓점 수를 최대 maxPoints개로 줄인다 */
export function thinRing(ring: Ring, maxPoints = 80): Ring {
  const open = ring.length > 1 && ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1]
    ? ring.slice(0, -1)
    : ring;
  const step = Math.max(1, Math.ceil(open.length / maxPoints));
  const thinned = open.filter((_, i) => i % step === 0);
  return [...thinned, thinned[0]];
}

export function ringToWkt(ring: Ring): string {
  const pts = thinRing(ring).map(([x, y]) => `${x.toFixed(6)} ${y.toFixed(6)}`);
  return `POLYGON((${pts.join(", ")}))`;
}
