import { type NextRequest, NextResponse } from "next/server";
import { searchCapcutTemplates } from "@/capcut/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
	const keyword = request.nextUrl.searchParams.get("q")?.trim() ?? "";
	if (!keyword) {
		return NextResponse.json(
			{ error: "Kata kunci pencarian wajib diisi." },
			{ status: 400 },
		);
	}
	if (keyword.length > 100) {
		return NextResponse.json(
			{ error: "Kata kunci terlalu panjang." },
			{ status: 400 },
		);
	}

	try {
		const result = await searchCapcutTemplates({ keyword });
		return NextResponse.json(result);
	} catch {
		return NextResponse.json(
			{ error: "Pencarian template CapCut gagal. Coba lagi sebentar." },
			{ status: 502 },
		);
	}
}
