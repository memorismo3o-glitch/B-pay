# Architecture

## 1. 전체 구성

```
┌──────────────────────┐        ┌──────────────────────────────┐
│  사용자 브라우저       │        │  Vercel (Next.js)             │
│  - 검색창              │──API──▶│  /api/search   지명 추출·구획  │──▶ Gemini API
│  - OSM 지도 (Leaflet)  │        │  /api/region   구획·식당 조회  │──▶ 상가정보 API (data.go.kr)
│  - 가능/불가능 버튼     │        │  /api/vote     투표 저장       │
└─────────▲────────────┘        └──────────────┬───────────────┘
          │ Realtime (읽기 전용)                 │ service_role (쓰기)
          │                                     ▼
          │                      ┌──────────────────────────────┐
          └──────────────────────│  Supabase (PostgreSQL)        │
                                 │  regions / stores /           │
                                 │  region_stores / store_status │
                                 └──────────────▲───────────────┘
                                                │ service_role (쓰기)
                                 ┌──────────────┴───────────────┐
                                 │  내 PC: 경계 수집기            │
                                 │  worker/collect.mjs           │──▶ Aside CLI ──▶ 네이버 지도
                                 └──────────────────────────────┘
```

| 구성 요소 | 역할 | 실행 위치 |
|---|---|---|
| 웹 화면 | 검색, 지도 표시, 투표, 실시간 반영 | 사용자 브라우저 |
| API 서버 | 지명 추출, 구획 관리, 식당 조회·저장, 투표 저장 | Vercel |
| DB | 구획 경계, 식당, 투표 결과 저장, 변경 알림 | Supabase |
| 경계 수집기 | 대기 중인 구획의 네이버 경계를 Aside로 수집 | 내 PC |

## 2. 데이터 흐름

### 2-1. 검색

1. 사용자가 "성수동 맛집 보여줘"를 입력하면 `POST /api/search`가 호출됩니다.
2. 서버가 Gemini로 지명 "성수동"을 뽑습니다. 키가 없거나 호출이 실패하면 단순 규칙으로 뽑습니다.
3. `regions`에서 이름으로 찾습니다.
   - 없으면 `status = 'pending'`으로 새로 등록합니다.
   - `failed`였으면 다시 `pending`으로 돌려 재수집하게 합니다.
4. 구획이 `ready`이고 식당 목록이 없거나 30일이 지났으면 상가정보 API로 다시 조회해 저장합니다.
5. 구획, 식당, 투표 상태를 한 번에 돌려줍니다.

### 2-2. 경계 수집

```
pending ──(수집기가 가져감)──▶ collecting ──(성공)──▶ ready
                                    └──────(실패)──▶ failed ──(다시 검색)──▶ pending
```

1. 수집기가 5초마다 `pending` 구획을 하나 가져옵니다.
2. `status = 'pending'` 조건을 걸고 `collecting`으로 바꿔서, 수집기가 여러 개여도 같은 구획을 두 번 처리하지 않습니다.
3. `aside repl`로 Aside 브라우저를 정해진 순서대로 조작합니다. AI 에이전트에게 맡기지 않아서 결과가 매번 같습니다.
   - `https://map.naver.com/p/search/<이름>`을 엽니다.
   - 페이지가 부르는 `/p/api/polygon` 요청을 찾아 그 응답을 그대로 받습니다. 응답은 경위도(WGS84) GeoJSON FeatureCollection입니다.
   - 탭 제목에서 정식 이름을 얻습니다. 예: "서울특별시 성동구 성수1가1동"
   - 경계가 없는 지명(예: "홍대")이면 `pcmap.place.naver.com` 검색 결과의 첫 장소 좌표를 중심점으로 씁니다.
4. 결과를 검사합니다.
   - 여러 개의 다각형이면 하나의 MultiPolygon으로 합칩니다.
   - 모든 점이 한국 범위 안인지 확인하고, 링이 닫혀 있지 않으면 닫습니다.
   - 경계가 없고 중심점만 있으면 반경 500m 원을 만들고 `source = 'radius'`로 둡니다.

참고: "성수동"처럼 법정동이 여러 개로 나뉜 이름은 네이버가 고른 하나(예: 성수동1가)의 경계만 나옵니다. 정확한 구획은 "성수1가1동"처럼 행정동 이름으로 검색하는 것이 좋습니다.
5. `ready`로 바꾸고 `stores_fetched_at`을 비웁니다. 그러면 다음 조회 때 서버가 식당 목록을 받아 옵니다.

### 2-3. 식당 조회

1. 폴리곤의 외곽 링마다 꼭짓점을 최대 80개로 줄여 WKT로 바꾸고 `storeListInPolygon`을 호출합니다. 업종 대분류는 `I2`(음식)이고, 1000건씩 페이지를 넘깁니다.
2. 다각형 조회가 실패하면 범위를 약 1km 격자로 나눠 `storeListInRectangle`로 조회합니다.
3. 꼭짓점을 줄여 조회했으므로 원래 경계로 다시 걸러 경계 밖 업소를 뺍니다.
4. `stores`와 `region_stores`에 upsert합니다.

### 2-4. 투표와 실시간 반영

1. 팝업에서 가능/불가능을 누르면 화면을 먼저 바꾸고(낙관적 업데이트) `POST /api/vote`를 호출합니다.
2. 서버가 `store_status`에 upsert합니다. 식당당 한 행이라 가장 최근 응답이 덮어씁니다.
3. Supabase Realtime이 다른 사용자 화면에 변경을 보냅니다.
4. Realtime 키가 없으면 15초마다 다시 불러옵니다. 구획이 수집 대기 중이면 4초마다 불러옵니다.

## 3. DB 스키마

```
regions ─────┐
  id (PK)    │ 1
  name (UQ)  │
  status     │        N
  polygon    ├──── region_stores ──── N ──┐
  ...        │       region_id (FK)        │
             │       bizes_id  (FK)        │
                                           │ 1
                                        stores ──── 1 : 0..1 ──── store_status
                                          bizes_id (PK)             bizes_id (PK, FK)
                                          name, lat, lon ...        status ('yes'|'no')
                                                                    updated_at
```

| 테이블 | 주요 컬럼 | 설명 |
|---|---|---|
| `regions` | `name`(고유), `status`, `polygon`(GeoJSON), `source`(naver/radius), `stores_fetched_at` | 검색된 구획과 수집 상태 |
| `stores` | `bizes_id`(상가업소번호), `name`, `category`, `address`, `lat`, `lon` | 상가정보 API의 음식점 |
| `region_stores` | `region_id`, `bizes_id` | 구획과 식당 연결. 한 식당이 여러 구획에 속할 수 있음 |
| `store_status` | `bizes_id`, `status`, `updated_at` | 비플페이 가능 여부. 최신 응답만 보관 |

**권한(RLS)**
- 모든 테이블은 누구나 읽을 수 있습니다 (anon `select`).
- 쓰기는 service_role 키를 가진 Vercel 서버와 내 PC 수집기만 할 수 있습니다.
- Realtime 대상은 `store_status`, `regions`입니다.

## 4. 폴더 구조

```
비플페이/
├─ src/
│  ├─ app/
│  │  ├─ page.tsx               메인 화면 (검색, 집계, 실시간 구독, 투표)
│  │  ├─ layout.tsx             HTML 뼈대, 메타데이터
│  │  ├─ globals.css            레이아웃, 마커(형광 깜빡임/회색), 팝업 스타일
│  │  └─ api/
│  │     ├─ search/route.ts     POST 검색 → 지명 추출 → 구획 조회/등록
│  │     ├─ region/[id]/route.ts GET 구획·식당·투표 상태
│  │     └─ vote/route.ts       POST 가능/불가능 저장
│  ├─ components/
│  │  └─ StoreMap.tsx           Leaflet 지도, 경계, 마커, 팝업 버튼
│  └─ lib/
│     ├─ types.ts               공통 타입
│     ├─ geo.ts                 폴리곤 계산 유틸
│     ├─ gemini.ts              Gemini 지명 추출 (+ 단순 규칙 대체)
│     ├─ storesApi.ts           상가정보 API 호출
│     ├─ repo.ts                Supabase 접근 / 샘플 모드 (서버 전용)
│     ├─ demo.ts                샘플 경계와 식당
│     └─ realtime.ts            브라우저용 Supabase 클라이언트 (anon)
├─ worker/
│  └─ collect.mjs               내 PC 경계 수집기 (Aside CLI 호출)
├─ supabase/
│  └─ schema.sql                테이블, RLS, Realtime 설정
├─ .env.example                 환경변수 목록
├─ README.md                    설정·실행 방법
├─ 작업절차.md                   작업 과정과 남은 절차
└─ architecture.md              이 문서
```

## 5. API

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| POST | `/api/search` | `{ query: string }` (최대 100자) | `{ place, region, stores[], demo }` |
| GET | `/api/region/:id` | - | `{ region, stores[], demo }` |
| POST | `/api/vote` | `{ bizesId, status: "yes" \| "no" }` | `{ ok, status_at }` |

`stores[]`의 각 항목: `bizes_id, name, branch, category, subcategory, address, lat, lon, status, status_at`

## 6. 환경변수

| 이름 | 사용처 | 노출 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | 서버, 브라우저, 수집기 | 공개 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 브라우저 (Realtime 읽기) | 공개 (읽기 전용) |
| `SUPABASE_SERVICE_ROLE_KEY` | 서버, 수집기 | 비공개 |
| `DATA_GO_KR_KEY` | 서버 | 비공개 |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | 서버 | 비공개 |
| `ASIDE_BIN`, `ASIDE_CLI_AUTH_PATH` | 수집기 | 내 PC 전용 |

Supabase 키가 없으면 서버가 **샘플 데이터 모드**로 동작합니다. 메모리에 둔 샘플 구획과 식당으로 화면을 확인하는 용도입니다.

## 7. 화면 표시 규칙

| 상태 | 마커 |
|---|---|
| 정보 없음 | 주황 점 |
| 비플페이 가능 | 초록 점 + 형광(#39FF14) 테두리와 빛번짐이 1초 간격으로 깜빡임, 다른 마커보다 위에 표시 |
| 비플페이 불가능 | 회색 점 |

구획 경계는 파란 점선으로 그리고, 검색하면 경계에 맞춰 지도를 확대합니다.

## 8. 설계상 선택과 한계

- **경계 수집이 내 PC에 의존**: Vercel에서는 Aside를 실행할 수 없기 때문입니다. 한 번 수집한 구획은 저장되므로 그 뒤에는 PC가 필요 없습니다.
- **투표는 서버 API로만 저장**: 브라우저에는 읽기 전용 키만 주고, 값 검사는 서버에서 합니다.
- **최신 응답 우선**: 식당당 한 행만 보관하므로 투표 이력은 남지 않습니다.
- **로그인 없음**: 누구나 투표할 수 있어 장난 입력을 막는 장치가 없습니다. 필요하면 횟수 제한을 추가합니다.
- **약관 위험**: 네이버 지도 데이터 자동 수집은 이용약관에 걸릴 수 있어, 장기적으로는 공공 행정경계 데이터로 바꾸는 것을 검토합니다.
