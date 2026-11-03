import { bbox, containsPoint, outerRings, ringToWkt } from "./geo";
import type { GeoPolygon, Store } from "./types";

// 소상공인시장진흥공단 상가(상권)정보 API
const BASE = "https://apis.data.go.kr/B553077/api/open/sdsc2";
const FOOD = "I2"; // 업종 대분류: 음식
const PAGE_SIZE = 1000;

interface ApiItem {
  bizesId: string;
  bizesNm: string;
  brchNm?: string;
  indsMclsNm?: string;
  indsSclsNm?: string;
  rdnmAdr?: string;
  lnoAdr?: string;
  lon: number | string;
  lat: number | string;
}

async function call(endpoint: string, params: Record<string, string>): Promise<{ items: ApiItem[]; total: number }> {
  const key = process.env.DATA_GO_KR_KEY;
  if (!key) throw new Error("DATA_GO_KR_KEY가 설정되지 않았습니다");
  const qs = new URLSearchParams({ serviceKey: key, type: "json", indsLclsCd: FOOD, ...params });
  const res = await fetch(`${BASE}/${endpoint}?${qs}`, { signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`상가정보 API 응답 오류 (${res.status}): ${text.slice(0, 200)}`);
  }
  const code = data?.header?.resultCode;
  if (code === "03") return { items: [], total: 0 }; // NODATA
  if (code !== "00") throw new Error(`상가정보 API 오류 ${code}: ${data?.header?.resultMsg}`);
  const items = data?.body?.items ?? [];
  return { items: Array.isArray(items) ? items : [items], total: Number(data?.body?.totalCount ?? 0) };
}

async function callAllPages(endpoint: string, params: Record<string, string>): Promise<ApiItem[]> {
  const all: ApiItem[] = [];
  for (let page = 1; page <= 30; page++) {
    const { items, total } = await call(endpoint, { ...params, pageNo: String(page), numOfRows: String(PAGE_SIZE) });
    all.push(...items);
    if (items.length < PAGE_SIZE || all.length >= total) break;
  }
  return all;
}

function toStore(i: ApiItem): Store {
  return {
    bizes_id: i.bizesId,
    name: i.bizesNm,
    branch: i.brchNm || null,
    category: i.indsMclsNm || null,
    subcategory: i.indsSclsNm || null,
    address: i.rdnmAdr || i.lnoAdr || null,
    lat: Number(i.lat),
    lon: Number(i.lon),
  };
}

/** 사각형을 격자로 나눠 조회한 뒤 폴리곤 안의 업소만 남긴다 (다각형 조회가 거부될 때 대비) */
async function viaRectangles(polygon: GeoPolygon): Promise<ApiItem[]> {
  const [minX, minY, maxX, maxY] = bbox(polygon);
  const cell = 0.01; // 약 1km
  const items: ApiItem[] = [];
  for (let x = minX; x < maxX; x += cell) {
    for (let y = minY; y < maxY; y += cell) {
      items.push(
        ...(await callAllPages("storeListInRectangle", {
          minx: x.toFixed(6),
          miny: y.toFixed(6),
          maxx: Math.min(x + cell, maxX).toFixed(6),
          maxy: Math.min(y + cell, maxY).toFixed(6),
        })),
      );
    }
  }
  return items;
}

export async function fetchStoresInPolygon(polygon: GeoPolygon): Promise<Store[]> {
  let items: ApiItem[] = [];
  try {
    for (const ring of outerRings(polygon)) {
      items.push(...(await callAllPages("storeListInPolygon", { key: ringToWkt(ring) })));
    }
  } catch (err) {
    console.warn("storeListInPolygon 실패, 사각형 조회로 전환:", err);
    items = await viaRectangles(polygon);
  }

  const byId = new Map<string, Store>();
  for (const it of items) {
    const s = toStore(it);
    if (!s.bizes_id || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    // 꼭짓점을 줄여 조회했으므로 원래 경계로 다시 거른다
    if (!containsPoint(polygon, s.lon, s.lat)) continue;
    byId.set(s.bizes_id, s);
  }
  return [...byId.values()];
}
