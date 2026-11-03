import { NextResponse } from "next/server";
import { getRegionPayload } from "@/lib/repo";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "잘못된 구획" }, { status: 400 });
  try {
    const payload = await getRegionPayload(id);
    if (!payload) return NextResponse.json({ error: "구획을 찾을 수 없어요." }, { status: 404 });
    return NextResponse.json(payload);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "서버 오류가 발생했어요." }, { status: 500 });
  }
}
