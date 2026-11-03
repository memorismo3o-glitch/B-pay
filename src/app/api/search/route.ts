import { NextResponse } from "next/server";
import { extractPlace } from "@/lib/gemini";
import { findOrRequestRegion, getRegionPayload } from "@/lib/repo";

export const maxDuration = 60;

export async function POST(req: Request) {
  const { query } = await req.json().catch(() => ({ query: "" }));
  if (typeof query !== "string" || !query.trim() || query.length > 100) {
    return NextResponse.json({ error: "동 이름이나 지명을 입력해 주세요." }, { status: 400 });
  }

  const place = await extractPlace(query);
  if (!place) {
    return NextResponse.json({ error: "문장에서 동 이름이나 지명을 찾지 못했어요." }, { status: 422 });
  }

  try {
    const region = await findOrRequestRegion(place);
    const payload = await getRegionPayload(region.id);
    return NextResponse.json({ place, ...payload });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "서버 오류가 발생했어요." }, { status: 500 });
  }
}
