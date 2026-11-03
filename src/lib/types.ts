export type GeoPolygon =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

export type RegionStatus = "pending" | "collecting" | "ready" | "failed";
export type PayStatus = "yes" | "no";

export interface Region {
  id: number;
  name: string;
  display_name: string | null;
  status: RegionStatus;
  polygon: GeoPolygon | null;
  source: string | null;
  error: string | null;
  stores_fetched_at: string | null;
  updated_at: string;
}

export interface Store {
  bizes_id: string;
  name: string;
  branch: string | null;
  category: string | null;
  subcategory: string | null;
  address: string | null;
  lat: number;
  lon: number;
}

export interface StoreWithStatus extends Store {
  status: PayStatus | null;
  status_at: string | null;
}

export interface RegionPayload {
  region: Region;
  stores: StoreWithStatus[];
  demo: boolean;
}
