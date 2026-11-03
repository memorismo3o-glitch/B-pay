# 비플페이 지도

동 이름이나 지명을 입력하면 그 구획의 식당을 지도에 띄우고, 사용자들이 비플페이 가능/불가능을 함께 표시하는 웹서비스.

- 지도: OpenStreetMap (Leaflet)
- 자연어 검색: Gemini (Vercel 서버에서 지명 추출)
- 식당 목록: 공공데이터포털 소상공인 상가(상권)정보 API, 업종 대분류 `음식`
- 동 경계 폴리곤: 내 PC의 Aside가 네이버 지도에서 수집 (`worker/collect.mjs`)
- 저장/실시간: Supabase, 배포: Vercel
- 표시: 가능 = 형광 테두리 깜빡임, 불가능 = 회색, 가장 최근 응답 기준

## 흐름

1. 사용자가 "성수동 맛집" 입력 → `/api/search`에서 Gemini가 "성수동" 추출
2. `regions`에 없으면 `pending`으로 등록 → 내 PC 수집기가 Aside로 경계 수집 → `ready`
3. 경계가 준비되면 서버가 상가정보 API(`storeListInPolygon`)로 식당을 받아 저장 (30일마다 갱신)
4. 가능/불가능 클릭 → `/api/vote` → `store_status` 갱신 → Supabase Realtime으로 모든 사용자 화면에 반영

경계가 없는 지명(예: "홍대")은 중심점 반경 500m 원을 구획으로 쓴다.

## 설정

1. Supabase 프로젝트 생성 → SQL Editor에서 `supabase/schema.sql` 실행
2. `.env.example`을 `.env.local`로 복사해서 키 입력
3. `npm install` → `npm run dev` → http://localhost:3000

Supabase 키가 없으면 샘플 데이터 모드로 화면만 확인할 수 있다.

## 경계 수집기 (내 PC)

1. Aside CLI 설치 (Aside 설정 > Developer, 또는 https://docs.aside.com/help/developers)
2. `aside account status`로 로그인 확인 (안 돼 있으면 `aside login --email <내 이메일>` 후 Aside 설정 > Account > Devices에서 승인)
3. `node worker/collect.mjs --test 성수1가1동` 으로 수집만 단독 테스트 (DB 불필요)
4. `npm run worker` (상시) 또는 `npm run worker:once` (대기 중인 것만 처리)

수집은 `aside repl`로 네이버 지도를 열어 페이지가 받는 경계 응답(`/p/api/polygon`, GeoJSON)을 그대로 가져온다.

수집기가 꺼져 있으면 새 동은 "수집 대기 중"으로 남고, 이미 수집된 동은 영향 없다.

## Vercel 배포

저장소를 Vercel에 연결하고 `.env.example`의 환경변수(수집기 전용 항목 제외)를 등록한다.
`SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `DATA_GO_KR_KEY`는 서버 전용이라 브라우저에 노출되지 않는다.
