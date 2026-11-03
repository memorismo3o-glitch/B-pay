import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DEMO_POLYGON, DEMO_STORES } from "./demo";
import { fetchStoresInPolygon } from "./storesApi";
import type { PayStatus, Region, RegionPayload, Store, StoreWithStatus } from "./types";

const STORES_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 식당 목록은 30일마다 새로 조회

export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

let client: SupabaseClient | null = null;
function db(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  client ??= createClient(url, key, { auth: { persistSession: false } });
  return client;
}

export const isDemo = () => db() === null;

// ---------- 데모 모드 (메모리) ----------
// 개발 서버는 라우트마다 모듈을 따로 불러오므로 globalThis에 두어 공유한다
type DemoState = {
  regions: Map<number, Region>;
  status: Map<string, { status: PayStatus; at: string }>;
  nextId: number;
};
const g = globalThis as typeof globalThis & { __bplDemo?: DemoState };
const demo: DemoState = (g.__bplDemo ??= { regions: new Map(), status: new Map(), nextId: 1 });

function demoRegion(name: string): Region {
  const found = [...demo.regions.values()].find((r) => r.name === name);
  if (found) return found;
  const now = new Date().toISOString();
  const r: Region = {
    id: demo.nextId++,
    name,
    display_name: `${name} (샘플 데이터)`,
    status: "ready",
    polygon: DEMO_POLYGON,
    source: "demo",
    error: null,
    stores_fetched_at: now,
    updated_at: now,
  };
  demo.regions.set(r.id, r);
  return r;
}

function withStatus(stores: Store[], statuses: Map<string, { status: PayStatus; at: string }>): StoreWithStatus[] {
  return stores.map((s) => {
    const st = statuses.get(s.bizes_id);
    return { ...s, status: st?.status ?? null, status_at: st?.at ?? null };
  });
}

// ---------- 공개 함수 ----------

/** 이름으로 구획을 찾고, 없으면 수집 대기열(pending)에 넣는다 */
export async function findOrRequestRegion(rawName: string): Promise<Region> {
  const name = normalizeName(rawName);
  const sb = db();
  if (!sb) return demoRegion(name);

  const { data: existing, error } = await sb.from("regions").select("*").eq("name", name).maybeSingle();
  if (error) throw error;
  if (existing) {
    if (existing.status === "failed") {
      // 다시 검색하면 재수집
      const { data, error: e } = await sb
        .from("regions")
        .update({ status: "pending", error: null, updated_at: new Date().toISOString() })
        .eq("id", existing.id)
        .select("*")
        .single();
      if (e) throw e;
      return data as Region;
    }
    return existing as Region;
  }

  const { data, error: insErr } = await sb.from("regions").insert({ name }).select("*").single();
  if (insErr) {
    // 동시에 같은 이름이 들어온 경우
    const { data: again } = await sb.from("regions").select("*").eq("name", name).single();
    if (again) return again as Region;
    throw insErr;
  }
  return data as Region;
}

export async function getRegionPayload(id: number): Promise<RegionPayload | null> {
  const sb = db();
  if (!sb) {
    const region = demo.regions.get(id);
    return region ? { region, stores: withStatus(DEMO_STORES, demo.status), demo: true } : null;
  }

  const { data: region, error } = await sb.from("regions").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!region) return null;
  if (region.status !== "ready" || !region.polygon) return { region, stores: [], demo: false };

  const stale = !region.stores_fetched_at || Date.now() - Date.parse(region.stores_fetched_at) > STORES_TTL_MS;
  if (stale) await refreshStores(sb, region as Region);

  const { data: links, error: e1 } = await sb
    .from("region_stores")
    .select("stores(*)")
    .eq("region_id", id)
    .limit(10000);
  if (e1) throw e1;
  const stores = (links ?? []).map((l: any) => l.stores as Store).filter(Boolean);

  const statuses = new Map<string, { status: PayStatus; at: string }>();
  const ids = stores.map((s) => s.bizes_id);
  for (let i = 0; i < ids.length; i += 500) {
    const { data: rows, error: e2 } = await sb
      .from("store_status")
      .select("bizes_id,status,updated_at")
      .in("bizes_id", ids.slice(i, i + 500));
    if (e2) throw e2;
    for (const r of rows ?? []) statuses.set(r.bizes_id, { status: r.status, at: r.updated_at });
  }

  const { data: fresh } = await sb.from("regions").select("*").eq("id", id).single();
  return { region: (fresh ?? region) as Region, stores: withStatus(stores, statuses), demo: false };
}

async function refreshStores(sb: SupabaseClient, region: Region) {
  try {
    const stores = await fetchStoresInPolygon(region.polygon!);
    const now = new Date().toISOString();
    for (let i = 0; i < stores.length; i += 500) {
      const chunk = stores.slice(i, i + 500);
      const { error } = await sb.from("stores").upsert(chunk.map((s) => ({ ...s, updated_at: now })));
      if (error) throw error;
      const { error: e2 } = await sb
        .from("region_stores")
        .upsert(chunk.map((s) => ({ region_id: region.id, bizes_id: s.bizes_id })), { ignoreDuplicates: true });
      if (e2) throw e2;
    }
    await sb.from("regions").update({ stores_fetched_at: now, error: null, updated_at: now }).eq("id", region.id);
  } catch (err) {
    console.error("refreshStores:", err);
    await sb.from("regions").update({ error: `식당 조회 실패: ${(err as Error).message}` }).eq("id", region.id);
  }
}

/** 가장 최근 응답이 이긴다 */
export async function setPayStatus(bizesId: string, status: PayStatus): Promise<string> {
  const at = new Date().toISOString();
  const sb = db();
  if (!sb) {
    if (!DEMO_STORES.some((s) => s.bizes_id === bizesId)) throw new Error("없는 식당입니다");
    demo.status.set(bizesId, { status, at });
    return at;
  }
  const { error } = await sb.from("store_status").upsert({ bizes_id: bizesId, status, updated_at: at });
  if (error) throw error;
  return at;
}
