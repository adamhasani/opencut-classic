import { type NextRequest, NextResponse } from "next/server";
import { CapcutFetchError, fetchCapcutTemplateDetail } from "@/capcut/server";

export const dynamic = "force-dynamic";

function isCapcutUrl({ url }: { url: string }): boolean {
	try {
		const parsed = new URL(url);
		return (
			parsed.protocol === "https:" &&
			(parsed.hostname === "capcut.com" ||
				parsed.hostname.endsWith(".capcut.com"))
		);
	} catch {
		return false;
	}
}

export async function GET(request: NextRequest) {
	const rawUrl = request.nextUrl.searchParams.get("url")?.trim() ?? "";
	if (!rawUrl) {
		return NextResponse.json(
			{ error: "Parameter url wajib diisi." },
			{ status: 400 },
		);
	}
	const withProtocol = /^https?:\/\//i.test(rawUrl)
		? rawUrl
		: `https://${rawUrl}`;
	if (!isCapcutUrl({ url: withProtocol })) {
		return NextResponse.json(
			{ error: "Link harus berasal dari capcut.com." },
			{ status: 400 },
		);
	}

	try {
		const meta = await fetchCapcutTemplateDetail({ url: withProtocol });
		return NextResponse.json({ template: meta });
	} catch (error) {
		return NextResponse.json(
			{
				error:
					error instanceof CapcutFetchError
						? error.message
						: "Gagal membaca halaman template CapCut.",
			},
			{ status: 502 },
		);
	}
}
