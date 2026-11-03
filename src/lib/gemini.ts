const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const FILLER = /(근처|주변|부근|일대|에\s*있는|의|식당|음식점|맛집|가게|목록|지도|보여\s*줘|보여\s*주세요|찾아\s*줘|알려\s*줘|검색|좀|요)$/;

/** Gemini 키가 없거나 호출이 실패하면 쓰는 단순 추출 */
export function extractPlaceSimple(query: string): string | null {
  let s = query.trim().replace(/[?!.,"']/g, " ").replace(/\s+/g, " ");
  for (let i = 0; i < 6; i++) {
    const next = s.replace(FILLER, "").trim();
    if (next === s) break;
    s = next;
  }
  return s.length > 0 && s.length <= 30 ? s : null;
}

/**
 * 자연어 문장에서 지명/동 이름 하나를 뽑는다.
 * 예: "성수동 맛집 보여줘" → "성수동", "을지로3가 근처 식당" → "을지로3가"
 */
export async function extractPlace(query: string): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return extractPlaceSimple(query);

  const prompt = [
    "사용자 문장에서 한국의 동 이름 또는 지명 하나만 뽑아라.",
    "네이버 지도 검색창에 그대로 넣을 수 있는 형태로, 문장에 있는 표기를 최대한 유지한다.",
    '시/구가 함께 적혀 있으면 포함한다 (예: "마포구 서교동").',
    "지명이 없으면 place를 null로 한다.",
    `문장: ${JSON.stringify(query)}`,
  ].join("\n");

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: { place: { type: "STRING", nullable: true } },
              required: ["place"],
            },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const data = await res.json();
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    const place = JSON.parse(text).place;
    return typeof place === "string" && place.trim() ? place.trim() : null;
  } catch (err) {
    console.error("extractPlace fallback:", err);
    return extractPlaceSimple(query);
  }
}
