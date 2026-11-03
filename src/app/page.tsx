"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browserClient } from "@/lib/realtime";
import type { PayStatus, RegionPayload } from "@/lib/types";

const StoreMap = dynamic(() => import("@/components/StoreMap"), { ssr: false });

const PENDING_POLL_MS = 4000;
const FALLBACK_POLL_MS = 15000;

export default function Home() {
  const [query, setQuery] = useState("");
  const [data, setData] = useState<RegionPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const regionId = data?.region.id;
  const regionStatus = data?.region.status;
  const reqSeq = useRef(0);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) return;
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      const json = await res.json();
      if (seq !== reqSeq.current) return;
      if (!res.ok) throw new Error(json.error ?? "검색 실패");
      setData(json);
      const url = new URL(window.location.href);
      url.searchParams.set("q", q);
      window.history.replaceState(null, "", url);
    } catch (e) {
      if (seq === reqSeq.current) setError((e as Error).message);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, []);

  const reload = useCallback(async (id: number) => {
    const res = await fetch(`/api/region/${id}`, { cache: "no-store" });
    if (!res.ok) return;
    const json: RegionPayload = await res.json();
    setData((prev) => (prev && prev.region.id === id ? json : prev));
  }, []);

  // 주소에 ?q= 가 있으면 바로 검색 (링크 공유용)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) {
      setQuery(q);
      search(q);
    }
  }, [search]);

  // 실시간 반영: Supabase Realtime, 없으면 주기적 새로고침
  useEffect(() => {
    if (regionId == null) return;
    const sb = browserClient();
    const pending = regionStatus === "pending" || regionStatus === "collecting";
    const timer = setInterval(() => reload(regionId), pending ? PENDING_POLL_MS : FALLBACK_POLL_MS * (sb ? 4 : 1));
    if (!sb) return () => clearInterval(timer);

    const channel = sb
      .channel(`region-${regionId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "store_status" }, (payload) => {
        const row = payload.new as { bizes_id?: string; status?: PayStatus; updated_at?: string };
        if (!row?.bizes_id) return;
        setData((prev) => {
          if (!prev || !prev.stores.some((s) => s.bizes_id === row.bizes_id)) return prev;
          return {
            ...prev,
            stores: prev.stores.map((s) =>
              s.bizes_id === row.bizes_id && (!s.status_at || s.status_at <= row.updated_at!)
                ? { ...s, status: row.status ?? null, status_at: row.updated_at ?? null }
                : s,
            ),
          };
        });
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "regions", filter: `id=eq.${regionId}` }, () =>
        reload(regionId),
      )
      .subscribe();
    return () => {
      clearInterval(timer);
      sb.removeChannel(channel);
    };
  }, [regionId, regionStatus, reload]);

  const vote = useCallback(async (bizesId: string, status: PayStatus) => {
    const optimisticAt = new Date().toISOString();
    setData((prev) =>
      prev && {
        ...prev,
        stores: prev.stores.map((s) => (s.bizes_id === bizesId ? { ...s, status, status_at: optimisticAt } : s)),
      },
    );
    const res = await fetch("/api/vote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bizesId, status }),
    });
    if (!res.ok) {
      setError("저장하지 못했어요. 다시 시도해 주세요.");
      if (regionId != null) reload(regionId);
    }
  }, [regionId, reload]);

  const counts = useMemo(() => {
    const c = { total: 0, yes: 0, no: 0 };
    for (const s of data?.stores ?? []) {
      c.total++;
      if (s.status === "yes") c.yes++;
      else if (s.status === "no") c.no++;
    }
    return c;
  }, [data?.stores]);

  const region = data?.region;
  let notice: string | null = null;
  if (region?.status === "pending") notice = `"${region.name}" 경계를 수집 대기 중이에요. 수집기가 켜져 있으면 곧 지도에 나타나요.`;
  else if (region?.status === "collecting") notice = `"${region.name}" 경계를 네이버 지도에서 수집하고 있어요…`;
  else if (region?.status === "failed") notice = `"${region.name}" 경계를 찾지 못했어요. ${region.error ?? ""} 다시 검색하면 재시도해요.`;
  else if (region?.status === "ready" && region.error) notice = region.error;

  return (
    <main className="app">
      <header className="bar">
        <h1 className="logo">
          비플페이 <span>지도</span>
        </h1>
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            search(query);
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="동 이름이나 지명 (예: 성수동, 을지로3가 근처 식당)"
            aria-label="동 이름이나 지명"
            maxLength={100}
          />
          <button type="submit" disabled={loading || !query.trim()}>
            {loading ? "찾는 중…" : "검색"}
          </button>
        </form>
      </header>

      {(error || notice || region) && (
        <div className="info">
          {region && (
            <strong className="info-region">
              {region.display_name ?? region.name}
              {region.source === "radius" && <em> (경계 없음 · 반경 500m)</em>}
            </strong>
          )}
          {region?.status === "ready" && (
            <span className="info-counts">
              식당 {counts.total.toLocaleString()} · <b className="c-yes">가능 {counts.yes}</b> ·{" "}
              <b className="c-no">불가능 {counts.no}</b>
            </span>
          )}
          {notice && <span className="info-notice">{notice}</span>}
          {error && <span className="info-error">{error}</span>}
          {data?.demo && <span className="info-demo">샘플 데이터 모드 (Supabase 미연결)</span>}
        </div>
      )}

      <div className="map-area">
        <StoreMap polygon={region?.polygon ?? null} stores={data?.stores ?? []} onVote={vote} />
        <div className="legend" aria-hidden>
          <span><i className="pin pin--yes" /> 비플페이 가능</span>
          <span><i className="pin pin--no" /> 불가능</span>
          <span><i className="pin" /> 정보 없음</span>
        </div>
      </div>
    </main>
  );
}
