// 동 경계 수집기 (내 PC에서 실행)
// Supabase의 regions 테이블에서 status='pending'인 구획을 가져와
// Aside 브라우저(aside repl)로 네이버 지도의 경계 폴리곤을 수집한 뒤 업로드한다.
//
//   npm run worker                 계속 대기하며 처리
//   npm run worker:once            대기 중인 것만 처리하고 종료
//   node worker/collect.mjs --test 성수1가1동   DB 없이 수집만 해보고 결과 출력

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(join(ROOT, ".env.local"));

const ASIDE_BIN = process.env.ASIDE_BIN || "aside";
const POLL_MS = 5000;
const ASIDE_TIMEOUT_MS = 150 * 1000; // aside repl 자체 제한은 120초
const FALLBACK_RADIUS_M = 500;
const RESULT_MARK = "__BPL_RESULT__";

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2].trim() && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

// Aside 브라우저 안에서 실행되는 코드.
// 1) 네이버 지도에서 검색 → 페이지가 부르는 /p/api/polygon 응답(GeoJSON)을 그대로 가져온다
// 2) 경계가 없는 지명이면 네이버 플레이스 첫 결과의 좌표를 중심점으로 쓴다
function replCode(name) {
  return `
const name = ${JSON.stringify(name)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = { name };
const page = await openTab("https://map.naver.com/p/search/" + encodeURIComponent(name));
try {
  let polyUrl = null;
  for (let i = 0; i < 24 && !polyUrl; i++) {
    await sleep(500);
    polyUrl = await page.evaluate(() =>
      performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/p/api/polygon")) || null);
  }
  if (polyUrl) {
    const got = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: "include" });
      return { status: r.status, body: await r.text(), title: document.title };
    }, polyUrl);
    result.display_name = got.title.replace(/\\s*-\\s*네이버\\s*지도\\s*$/, "").trim() || null;
    result.polygonStatus = got.status;
    result.geojson = got.status === 200 ? JSON.parse(got.body) : null;
  }
} finally {
  try { await page.close(); } catch {}
}
if (!result.geojson) {
  const list = await openTab("https://pcmap.place.naver.com/place/list?query=" + encodeURIComponent(name) + "&x=126.978&y=37.5665&display=10&locale=ko");
  try {
    let first = null;
    for (let i = 0; i < 16 && !first; i++) {
      await sleep(500);
      first = await list.evaluate(() => {
        const st = window.__APOLLO_STATE__;
        if (!st) return null;
        const v = Object.values(st).find((v) => v && typeof v === "object" && v.x && v.y && v.name);
        return v ? { name: v.name, x: Number(v.x), y: Number(v.y) } : null;
      });
    }
    if (first) {
      result.center = [first.x, first.y];
      result.display_name = name + " (" + first.name + " 기준)";
    }
  } finally {
    try { await list.close(); } catch {}
  }
}
console.log(${JSON.stringify(RESULT_MARK)} + JSON.stringify(result));
`;
}

function runRepl(code) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ASIDE_BIN, ["repl", code], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Aside 작업 시간 초과"));
    }, ASIDE_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Aside 실행 실패 (${ASIDE_BIN}): ${err.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).find((l) => l.includes(RESULT_MARK));
      if (!line) return reject(new Error(`Aside 결과 없음: ${out.replace(/\x1b\[[0-9;]*m/g, "").slice(-400)}`));
      resolvePromise(JSON.parse(line.slice(line.indexOf(RESULT_MARK) + RESULT_MARK.length)));
    });
  });
}

const inKorea = ([lon, lat]) => lon > 124 && lon < 132 && lat > 33 && lat < 39.5;

function cleanRing(ring) {
  const pts = ring.map((p) => [Number(p[0]), Number(p[1])]);
  if (pts.length < 3 || !pts.every(inKorea)) throw new Error("경계 좌표가 한국 범위를 벗어났습니다");
  const [f, l] = [pts[0], pts.at(-1)];
  if (f[0] !== l[0] || f[1] !== l[1]) pts.push([...f]);
  return pts;
}

/** 네이버 FeatureCollection → 하나의 Polygon/MultiPolygon */
function toPolygon(geojson) {
  const geoms = geojson?.type === "FeatureCollection"
    ? geojson.features.map((f) => f.geometry)
    : [geojson?.geometry ?? geojson];
  const polys = [];
  for (const g of geoms) {
    if (g?.type === "Polygon") polys.push(g.coordinates);
    else if (g?.type === "MultiPolygon") polys.push(...g.coordinates);
  }
  if (!polys.length) return null;
  const cleaned = polys.map((poly) => poly.map(cleanRing));
  return cleaned.length === 1
    ? { type: "Polygon", coordinates: cleaned[0] }
    : { type: "MultiPolygon", coordinates: cleaned };
}

function circle([lon, lat], radiusM, n = 48) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  const ring = Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)];
  });
  ring.push([...ring[0]]);
  return { type: "Polygon", coordinates: [ring] };
}

async function collect(name) {
  const r = await runRepl(replCode(name));
  const polygon = r.geojson && toPolygon(r.geojson);
  if (polygon) return { polygon, source: "naver", display_name: r.display_name ?? null };
  if (r.center && inKorea(r.center)) {
    return { polygon: circle(r.center, FALLBACK_RADIUS_M), source: "radius", display_name: r.display_name ?? null };
  }
  throw new Error("네이버 지도에서 경계와 위치를 모두 찾지 못했습니다");
}

// ---------- 테스트 모드 ----------
if (process.argv.includes("--test")) {
  const name = process.argv.slice(process.argv.indexOf("--test") + 1).join(" ") || "성수1가1동";
  const r = await collect(name);
  const rings = r.polygon.type === "Polygon" ? [r.polygon.coordinates[0]] : r.polygon.coordinates.map((p) => p[0]);
  console.log(JSON.stringify({
    name,
    display_name: r.display_name,
    source: r.source,
    type: r.polygon.type,
    rings: rings.length,
    points: rings.reduce((n, ring) => n + ring.length, 0),
    firstPoint: rings[0][0],
  }, null, 1));
  process.exit(0);
}

// ---------- 대기열 처리 ----------
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(".env.local에 NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY를 넣어 주세요.");
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function processNext() {
  const { data: region, error } = await sb
    .from("regions")
    .select("*")
    .eq("status", "pending")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!region) return false;

  // 다른 수집기가 먼저 가져가지 않았을 때만 진행
  const { data: claimed } = await sb
    .from("regions")
    .update({ status: "collecting", updated_at: new Date().toISOString() })
    .eq("id", region.id)
    .eq("status", "pending")
    .select("id");
  if (!claimed?.length) return true;

  console.log(`[${region.id}] "${region.name}" 수집 시작`);
  try {
    const r = await collect(region.name);
    await sb
      .from("regions")
      .update({ ...r, status: "ready", error: null, stores_fetched_at: null, updated_at: new Date().toISOString() })
      .eq("id", region.id);
    console.log(`[${region.id}] 완료 (${r.source}) ${r.display_name ?? ""}`);
  } catch (err) {
    console.error(`[${region.id}] 실패:`, err.message);
    await sb
      .from("regions")
      .update({ status: "failed", error: String(err.message).slice(0, 500), updated_at: new Date().toISOString() })
      .eq("id", region.id);
  }
  return true;
}

const once = process.argv.includes("--once");
console.log(`경계 수집기 시작 (${once ? "1회" : "상시"}), Aside: ${ASIDE_BIN}`);
for (;;) {
  let worked = false;
  try {
    worked = await processNext();
  } catch (err) {
    console.error("대기열 확인 실패:", err.message);
  }
  if (!worked) {
    if (once) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
