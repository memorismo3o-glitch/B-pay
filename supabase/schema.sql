-- 비플페이 지도: Supabase SQL Editor에 붙여넣고 한 번 실행하세요.

-- 구획(동/지명). polygon은 GeoJSON Polygon 또는 MultiPolygon (경도, 위도 순서)
create table if not exists public.regions (
  id               bigint generated always as identity primary key,
  name             text not null unique,          -- 정규화된 검색 이름 (예: 성수동)
  display_name     text,                          -- 네이버에서 확인된 전체 이름 (예: 서울 성동구 성수1가1동)
  status           text not null default 'pending'
                   check (status in ('pending', 'collecting', 'ready', 'failed')),
  polygon          jsonb,
  source           text,                          -- naver | radius
  error            text,
  stores_fetched_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- 상가업소 (공공데이터포털 소상공인 상가정보)
create table if not exists public.stores (
  bizes_id    text primary key,                   -- 상가업소번호
  name        text not null,
  branch      text,
  category    text,                               -- 업종 중분류
  subcategory text,                               -- 업종 소분류
  address     text,
  lat         double precision not null,
  lon         double precision not null,
  updated_at  timestamptz not null default now()
);

create table if not exists public.region_stores (
  region_id bigint not null references public.regions(id) on delete cascade,
  bizes_id  text   not null references public.stores(bizes_id) on delete cascade,
  primary key (region_id, bizes_id)
);

-- 비플페이 가능 여부: 식당당 한 행, 가장 최근 응답이 덮어씀
create table if not exists public.store_status (
  bizes_id   text primary key references public.stores(bizes_id) on delete cascade,
  status     text not null check (status in ('yes', 'no')),
  updated_at timestamptz not null default now()
);

-- 읽기는 누구나, 쓰기는 서버(service role)만
alter table public.regions       enable row level security;
alter table public.stores        enable row level security;
alter table public.region_stores enable row level security;
alter table public.store_status  enable row level security;

drop policy if exists "public read" on public.regions;
drop policy if exists "public read" on public.stores;
drop policy if exists "public read" on public.region_stores;
drop policy if exists "public read" on public.store_status;
create policy "public read" on public.regions       for select using (true);
create policy "public read" on public.stores        for select using (true);
create policy "public read" on public.region_stores for select using (true);
create policy "public read" on public.store_status  for select using (true);

-- 실시간 반영 (다른 사용자의 선택, 수집 완료)
do $$
begin
  begin
    alter publication supabase_realtime add table public.store_status;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.regions;
  exception when duplicate_object then null;
  end;
end $$;
