import { NextResponse } from "next/server";
import { setPayStatus } from "@/lib/repo";

export async function POST(req: Request) {
  const { bizesId, status } = await req.json().catch(() => ({}));
  if (typeof bizesId !== "string" || !bizesId || (status !== "yes" && status !== "no")) {
    return NextResponse.json({ error: "잘못된 요청" }, { status: 400 });
  }
  try {
    const at = await setPayStatus(bizesId, status);
    return NextResponse.json({ ok: true, status_at: at });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "저장하지 못했어요." }, { status: 500 });
  }
}
