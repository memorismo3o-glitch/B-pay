// 동 경계 수집기 (내 PC에서 실행)
// Supabase의 regions 테이블에서 status='pending'인 구획을 가져와
// Aside CLI로 네이버 지도의 경계 폴리곤을 수집한 뒤 업로드한다.
//
//   npm run worker        계속 대기하며 처리
//   npm run worker:once   대기 중인 것만 처리하고 종료

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(join(ROOT, ".env.local"));

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ASIDE_BIN = process.env.ASIDE_BIN || "aside";
const POLL_MS = 5000;
const ASIDE_TIMEOUT_MS = 6 * 60 * 1000;
const FALLBACK_RADIUS_M = 500;
const TMP = join(ROOT, "worker", "tmp");

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(".env.local에 NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY를 넣어 주세요.");
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
mkdirSync(TMP, { recursive: true });

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function buildPrompt(name, outFile) {
  return [
    `네이버 지도(https://map.naver.com/p/search/${encodeURIComponent(name)})에서 "${name}"을(를) 검색해.`,
    `검색 결과로 지도에 표시되는 행정구역 경계(폴리곤)의 좌표를 구해.`,
    `좌표는 추측하거나 손으로 그리지 말고, 페이지가 받아오는 네트워크 응답(경계/geometry/polygon 좌표가 담긴 응답)에서 그대로 가져와.`,
    `좌표계는 WGS84 경위도로 맞추고, 각 점은 [경도, 위도] 순서야.`,
    `결과를 다음 파일에 JSON 하나만 저장해 (다른 텍스트 없이): ${outFile}`,
    `형식: {"display_name": "네이버에 표시된 정식 이름 (예: 서울특별시 성동구 성수1가1동)",`,
    `       "polygon": {"type": "Polygon", "coordinates": [[[경도, 위도], ...]]} 또는 MultiPolygon,`,
    `       "center": [경도, 위도]}`,
    `검색어가 행정구역이 아니어서 경계가 없으면 "polygon": null 로 두고 center만 채워.`,
    `검색 결과가 전혀 없으면 {"error": "이유"} 를 저장해.`,
    `로그인, 결제, 글쓰기 같은 다른 동작은 하지 마.`,
  ].join("\n");
}

function runAside(prompt) {
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env };
    const child = spawn(ASIDE_BIN, [prompt], { env, windowsHide: true });
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
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolvePromise(out) : reject(new Error(`Aside 종료 코드 ${code}: ${out.slice(-500)}`));
    });
  });
}

// EPSG:3857(웹 메르카토르) 좌표가 오면 경위도로 변환
function to4326([x, y]) {
  if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return [x, y];
  const lon = (x / 6378137) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * (180 / Math.PI);
  return [lon, lat];
}

const inKorea = ([lon, lat]) => lon > 124 && lon < 132 && lat > 33 && lat < 39.5;

function cleanRing(ring) {
  const pts = ring.map((p) => to4326(p.map(Number)));
  if (pts.length < 3 || !pts.every(inKorea)) throw new Error("경계 좌표가 한국 범위를 벗어났습니다");
  const [f, l] = [pts[0], pts.at(-1)];
  if (f[0] !== l[0] || f[1] !== l[1]) pts.push([...f]);
  return pts;
}

function cleanPolygon(p) {
  if (p?.type === "Polygon") return { type: "Polygon", coordinates: p.coordinates.map(cleanRing) };
  if (p?.type === "MultiPolygon")
    return { type: "MultiPolygon", coordinates: p.coordinates.map((poly) => poly.map(cleanRing)) };
  throw new Error("polygon 형식이 올바르지 않습니다");
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

async function collect(region) {
  const outFile = join(TMP, `region-${region.id}.json`);
  rmSync(outFile, { force: true });
  console.log(`[${region.id}] "${region.name}" 수집 시작`);
  await runAside(buildPrompt(region.name, outFile));
  if (!existsSync(outFile)) throw new Error("Aside가 결과 파일을 만들지 않았습니다");

  const raw = readFileSync(outFile, "utf8").trim().replace(/^```(?:json)?|```$/g, "");
  const result = JSON.parse(raw);
  if (result.error) throw new Error(`네이버 검색 결과 없음: ${result.error}`);

  if (result.polygon) {
    return { polygon: cleanPolygon(result.polygon), source: "naver", display_name: result.display_name ?? null };
  }
  const center = result.center && to4326(result.center.map(Number));
  if (center && inKorea(center)) {
    return { polygon: circle(center, FALLBACK_RADIUS_M), source: "radius", display_name: result.display_name ?? null };
  }
  throw new Error("경계와 중심 좌표를 모두 찾지 못했습니다");
}

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

  try {
    const r = await collect(region);
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
