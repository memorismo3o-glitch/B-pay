"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { GeoPolygon, PayStatus, StoreWithStatus } from "@/lib/types";

interface Props {
  polygon: GeoPolygon | null;
  stores: StoreWithStatus[];
  onVote: (bizesId: string, status: PayStatus) => void;
}

const SEOUL: L.LatLngTuple = [37.5665, 126.978];

function icon(status: PayStatus | null) {
  const cls = status === "yes" ? "pin pin--yes" : status === "no" ? "pin pin--no" : "pin";
  return L.divIcon({ className: "pin-wrap", html: `<span class="${cls}"></span>`, iconSize: [22, 22], iconAnchor: [11, 11] });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function popupHtml(s: StoreWithStatus) {
  const title = escapeHtml(s.name + (s.branch ? ` ${s.branch}` : ""));
  const cat = escapeHtml([s.category, s.subcategory].filter(Boolean).join(" · "));
  const state =
    s.status === "yes" ? '<span class="tag tag--yes">비플페이 가능</span>'
    : s.status === "no" ? '<span class="tag tag--no">비플페이 불가능</span>'
    : '<span class="tag">아직 정보 없음</span>';
  const when = s.status_at ? `<div class="popup-when">마지막 응답 ${new Date(s.status_at).toLocaleString("ko-KR")}</div>` : "";
  return `
    <div class="popup">
      <div class="popup-title">${title}</div>
      ${cat ? `<div class="popup-cat">${cat}</div>` : ""}
      ${s.address ? `<div class="popup-addr">${escapeHtml(s.address)}</div>` : ""}
      <div class="popup-state">${state}</div>
      ${when}
      <div class="popup-actions">
        <button type="button" data-vote="yes" class="btn btn--yes${s.status === "yes" ? " is-active" : ""}">비플페이 가능</button>
        <button type="button" data-vote="no" class="btn btn--no${s.status === "no" ? " is-active" : ""}">비플페이 불가능</button>
      </div>
    </div>`;
}

export default function StoreMap({ polygon, stores, onVote }: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const polyLayer = useRef<L.GeoJSON | null>(null);
  const markers = useRef(new Map<string, { marker: L.Marker; store: StoreWithStatus }>());
  const voteRef = useRef(onVote);
  voteRef.current = onVote;

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { zoomControl: true }).setView(SEOUL, 12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      markers.current.clear();
    };
  }, []);

  // 구획 경계
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    polyLayer.current?.remove();
    polyLayer.current = null;
    if (!polygon) return;
    const layer = L.geoJSON(polygon as GeoJSON.Geometry, {
      style: { color: "#2563eb", weight: 3, fillColor: "#3b82f6", fillOpacity: 0.06, dashArray: "6 4" },
      interactive: false,
    }).addTo(map);
    polyLayer.current = layer;
    map.fitBounds(layer.getBounds(), { padding: [24, 24] });
  }, [polygon]);

  // 식당 마커: 바뀐 것만 갱신
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const seen = new Set<string>();
    for (const s of stores) {
      seen.add(s.bizes_id);
      const existing = markers.current.get(s.bizes_id);
      if (existing) {
        if (existing.store.status !== s.status || existing.store.status_at !== s.status_at) {
          existing.marker.setIcon(icon(s.status));
          existing.marker.setZIndexOffset(s.status === "yes" ? 1000 : 0);
          existing.marker.setPopupContent(popupHtml(s));
        }
        existing.store = s;
        continue;
      }
      const marker = L.marker([s.lat, s.lon], {
        icon: icon(s.status),
        title: s.name,
        zIndexOffset: s.status === "yes" ? 1000 : 0,
      })
        .bindPopup(popupHtml(s), { minWidth: 220 })
        .addTo(map);
      marker.on("popupopen", (e) => {
        const root = (e as L.PopupEvent).popup.getElement();
        root?.querySelectorAll<HTMLButtonElement>("button[data-vote]").forEach((btn) => {
          btn.onclick = () => voteRef.current(s.bizes_id, btn.dataset.vote as PayStatus);
        });
      });
      markers.current.set(s.bizes_id, { marker, store: s });
    }
    for (const [id, { marker }] of markers.current) {
      if (!seen.has(id)) {
        marker.remove();
        markers.current.delete(id);
      }
    }
  }, [stores]);

  // 팝업 내용이 바뀌면 버튼 핸들러 다시 연결
  useEffect(() => {
    for (const { marker, store } of markers.current.values()) {
      if (!marker.isPopupOpen()) continue;
      marker.getPopup()?.getElement()?.querySelectorAll<HTMLButtonElement>("button[data-vote]").forEach((btn) => {
        btn.onclick = () => voteRef.current(store.bizes_id, btn.dataset.vote as PayStatus);
      });
    }
  }, [stores]);

  return <div ref={elRef} className="map" />;
}
