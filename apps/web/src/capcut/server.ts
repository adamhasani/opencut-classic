import type { CapcutTemplateMeta } from "./types";

/**
 * Server-side reader for CapCut's public template pages.
 *
 * CapCut template pages (detail + keyword explore pages) are server-side
 * rendered with a JSON state blob (`__MODERN_ROUTER_DATA__`) that contains
 * only public display metadata: title, cover image, duration, aspect
 * ratio, clip-slot count and usage count. This module fetches those pages
 * from the server (the browser cannot, due to CORS) and extracts that
 * public metadata. It never touches template project files, preview
 * videos as editing material, music, or any other creator asset.
 */

const BROWSER_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 20_000;

export class CapcutFetchError extends Error {}

async function fetchCapcutHtml({ url }: { url: string }): Promise<string> {
	let response: Response;
	try {
		response = await fetch(url, {
			headers: {
				"user-agent": BROWSER_USER_AGENT,
				"accept-language": "id-ID,id;q=0.9,en;q=0.8",
			},
			redirect: "follow",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch {
		throw new CapcutFetchError(
			"Tidak bisa menghubungi capcut.com. Periksa koneksi lalu coba lagi.",
		);
	}
	if (!response.ok) {
		throw new CapcutFetchError(
			`Halaman CapCut tidak bisa dibuka (HTTP ${response.status}).`,
		);
	}
	return response.text();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract the embedded router-state JSON from a CapCut page. Primary path:
 * the `<script type="application/json" id="__MODERN_ROUTER_DATA__">` blob.
 * Fallback: brace-balance scan starting at the first `"templateDetail"`
 * or `"videoTemplateList"` key, in case the script id changes.
 */
export function extractRouterData({ html }: { html: string }): unknown {
	const scriptMatch = html.match(
		/<script[^>]*id="__MODERN_ROUTER_DATA__"[^>]*>([\s\S]*?)<\/script>/,
	);
	if (scriptMatch) {
		try {
			return JSON.parse(scriptMatch[1]);
		} catch {
			// fall through to the brace-balance scan
		}
	}

	for (const key of ['"templateDetail"', '"videoTemplateList"', '"templateData"']) {
		const keyIndex = html.indexOf(key);
		if (keyIndex === -1) continue;
		const start = html.lastIndexOf("{", keyIndex);
		if (start === -1) continue;
		const parsed = parseBalancedObject({ html, start });
		if (parsed) return parsed;
	}
	return null;
}

function parseBalancedObject({
	html,
	start,
}: {
	html: string;
	start: number;
}): unknown {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < html.length; i++) {
		const char = html[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(html.slice(start, i + 1));
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

/** Depth-first walk over every object in a parsed JSON tree. */
function walkObjects({
	value,
	visit,
}: {
	value: unknown;
	visit: (obj: Record<string, unknown>) => void;
}): void {
	if (Array.isArray(value)) {
		for (const item of value) walkObjects({ value: item, visit });
		return;
	}
	if (!isRecord(value)) return;
	visit(value);
	for (const child of Object.values(value)) {
		walkObjects({ value: child, visit });
	}
}

function toNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

interface RawTemplateDetail {
	templateId: string;
	title: string;
	coverUrl: string | null;
	authorName: string | null;
	templateDuration: number;
	videoRatio: string | null;
	videoWidth: number | null;
	videoHeight: number | null;
	segmentAmount: number | null;
	usageAmount: number | null;
}

function asRawDetail({
	obj,
}: {
	obj: Record<string, unknown>;
}): RawTemplateDetail | null {
	const templateId = toNonEmptyString(obj.templateId);
	const title = toNonEmptyString(obj.title);
	const templateDuration = toNumber(obj.templateDuration);
	if (!templateId || !title || templateDuration === null) return null;
	const author = isRecord(obj.author) ? obj.author : null;
	return {
		templateId,
		title,
		coverUrl: toNonEmptyString(obj.coverUrl),
		authorName: author ? toNonEmptyString(author.name) : null,
		templateDuration,
		videoRatio: toNonEmptyString(obj.videoRatio),
		videoWidth: toNumber(obj.videoWidth),
		videoHeight: toNumber(obj.videoHeight),
		segmentAmount: toNumber(obj.segmentAmount),
		usageAmount: toNumber(obj.usageAmount),
	};
}

/**
 * Collect every template-detail-shaped object in the page state. Detail
 * pages embed the requested template plus recommendation entries (which
 * carry zero duration/segments), so candidates are scored and the real
 * one wins.
 */
function collectDetails({ data }: { data: unknown }): RawTemplateDetail[] {
	const details: RawTemplateDetail[] = [];
	const seen = new Set<string>();
	walkObjects({
		value: data,
		visit: (obj) => {
			const candidates: unknown[] = [];
			if ("templateDetail" in obj) candidates.push(obj.templateDetail);
			candidates.push(obj);
			for (const candidate of candidates) {
				if (!isRecord(candidate)) continue;
				const detail = asRawDetail({ obj: candidate });
				if (detail && !seen.has(detail.templateId)) {
					seen.add(detail.templateId);
					details.push(detail);
				}
			}
		},
	});
	return details;
}

function detailScore({ detail }: { detail: RawTemplateDetail }): number {
	let score = 0;
	if (detail.templateDuration > 0) score += 2;
	if ((detail.segmentAmount ?? 0) > 0) score += 2;
	if (detail.coverUrl) score += 1;
	return score;
}

function toMeta({
	detail,
	detailUrl,
}: {
	detail: RawTemplateDetail;
	detailUrl: string;
}): CapcutTemplateMeta {
	return {
		id: detail.templateId,
		title: detail.title,
		coverUrl: detail.coverUrl,
		authorName: detail.authorName,
		durationMs: detail.templateDuration,
		ratio: detail.videoRatio,
		width: detail.videoWidth,
		height: detail.videoHeight,
		segmentCount: detail.segmentAmount,
		usageCount: detail.usageAmount,
		detailUrl,
	};
}

function canonicalDetailUrl({ templateId }: { templateId: string }): string {
	return `https://www.capcut.com/template-detail/${templateId}`;
}

/**
 * Read the public metadata of one template from its share/detail URL
 * (capcut.com/t/..., /tv2/..., /template-detail/... all resolve to a
 * detail page).
 */
export async function fetchCapcutTemplateDetail({
	url,
}: {
	url: string;
}): Promise<CapcutTemplateMeta> {
	const html = await fetchCapcutHtml({ url });
	const data = extractRouterData({ html });
	if (!data) {
		throw new CapcutFetchError(
			"Data template tidak ditemukan di halaman CapCut. Link mungkin sudah tidak berlaku.",
		);
	}

	const wantedId =
		url.match(/template_id=(\d+)/)?.[1] ??
		url.match(/template-detail\/(?:[^/]+\/)?(\d{6,})/)?.[1] ??
		null;

	const details = collectDetails({ data });
	const chosen =
		(wantedId
			? details.find((detail) => detail.templateId === wantedId)
			: undefined) ??
		[...details].sort(
			(a, b) => detailScore({ detail: b }) - detailScore({ detail: a }),
		)[0];

	if (!chosen || chosen.templateDuration <= 0) {
		throw new CapcutFetchError(
			"Metadata template tidak lengkap di halaman CapCut (durasi tidak terbaca), jadi proyek tiruan tidak dibuat.",
		);
	}
	if (!chosen.segmentAmount || chosen.segmentAmount <= 0) {
		throw new CapcutFetchError(
			"Jumlah slot klip template tidak terbaca dari halaman CapCut, jadi proyek tiruan tidak dibuat.",
		);
	}

	return toMeta({
		detail: chosen,
		detailUrl: canonicalDetailUrl({ templateId: chosen.templateId }),
	});
}

interface RawSearchItem {
	templateId: string;
	title: string;
	coverUrl: string | null;
	templateDuration: number;
	useCount: number | null;
	clipsCount: number | null;
	coverWidth: number | null;
	coverHeight: number | null;
	aspectRatio: string | null;
	detailUrl: string;
}

function collectSearchItems({ data }: { data: unknown }): RawSearchItem[] {
	const items: RawSearchItem[] = [];
	const seen = new Set<string>();
	walkObjects({
		value: data,
		visit: (obj) => {
			if (!Array.isArray(obj.videoTemplates)) return;
			for (const raw of obj.videoTemplates) {
				if (!isRecord(raw)) continue;
				const templateId = toNonEmptyString(raw.templateId);
				const title = toNonEmptyString(raw.title);
				const templateDuration = toNumber(raw.templateDuration);
				if (!templateId || !title || templateDuration === null) continue;
				if (seen.has(templateId)) continue;
				seen.add(templateId);
				const structured = isRecord(raw.structuredData)
					? raw.structuredData
					: null;
				items.push({
					templateId,
					title,
					coverUrl: toNonEmptyString(raw.coverUrl),
					templateDuration,
					useCount:
						toNumber(raw.useCount) ??
						(structured &&
						isRecord(structured.interactionStatistic)
							? toNumber(structured.interactionStatistic.useCount)
							: null),
					clipsCount: structured ? toNumber(structured.clipsCount) : null,
					coverWidth: toNumber(raw.coverWidth),
					coverHeight: toNumber(raw.coverHeight),
					aspectRatio: structured
						? toNonEmptyString(structured.aspectRatio)
						: null,
					detailUrl:
						(structured ? toNonEmptyString(structured.url) : null) ??
						canonicalDetailUrl({ templateId }),
				});
			}
		},
	});
	return items;
}

function rawItemToMeta({ item }: { item: RawSearchItem }): CapcutTemplateMeta {
	return {
		id: item.templateId,
		title: item.title,
		coverUrl: item.coverUrl,
		authorName: null,
		durationMs: item.templateDuration,
		ratio: item.aspectRatio,
		width: item.coverWidth,
		height: item.coverHeight,
		segmentCount: item.clipsCount,
		usageCount: item.useCount,
		detailUrl: item.detailUrl,
	};
}

export function slugifyKeyword({ keyword }: { keyword: string }): string {
	return keyword
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/[\s_]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

export type CapcutSearchSource = "capcut-explore" | "search-index";

export interface CapcutSearchResult {
	templates: CapcutTemplateMeta[];
	source: CapcutSearchSource;
}

/**
 * Search public video templates by keyword. Primary path: CapCut's own
 * public keyword explore pages, whose embedded state lists video
 * templates with covers/durations/usage counts. Fallback: a public
 * search-engine index of capcut.com template-detail pages, whose detail
 * pages are then read individually for card metadata.
 */
export async function searchCapcutTemplates({
	keyword,
}: {
	keyword: string;
}): Promise<CapcutSearchResult> {
	const slug = slugifyKeyword({ keyword });
	if (slug) {
		for (const exploreUrl of [
			`https://www.capcut.com/id-id/explore/${slug}`,
			`https://www.capcut.com/explore/${slug}`,
		]) {
			try {
				const html = await fetchCapcutHtml({ url: exploreUrl });
				const data = extractRouterData({ html });
				if (!data) continue;
				const items = collectSearchItems({ data });
				if (items.length > 0) {
					return {
						templates: items.slice(0, 24).map((item) => rawItemToMeta({ item })),
						source: "capcut-explore",
					};
				}
			} catch {
				// try the next explore variant, then the index fallback
			}
		}
	}

	const detailUrls = await searchIndexDetailUrls({ keyword });
	const templates: CapcutTemplateMeta[] = [];
	for (const detailUrl of detailUrls.slice(0, 8)) {
		try {
			templates.push(await fetchCapcutTemplateDetail({ url: detailUrl }));
		} catch {
			// skip results whose pages no longer expose metadata
		}
	}
	return { templates, source: "search-index" };
}

async function searchIndexDetailUrls({
	keyword,
}: {
	keyword: string;
}): Promise<string[]> {
	const query = encodeURIComponent(`site:capcut.com/template-detail ${keyword}`);
	let html: string;
	try {
		const response = await fetch(
			`https://html.duckduckgo.com/html/?q=${query}`,
			{
				headers: { "user-agent": BROWSER_USER_AGENT },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			},
		);
		if (!response.ok) return [];
		html = await response.text();
	} catch {
		return [];
	}

	const urls: string[] = [];
	const seen = new Set<string>();
	for (const match of html.matchAll(/uddg=([^&"]+)/g)) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(match[1]);
		} catch {
			continue;
		}
		if (!/capcut\.com\/template-detail\//.test(decoded)) continue;
		const clean = decoded.split("?")[0];
		if (seen.has(clean)) continue;
		seen.add(clean);
		urls.push(clean);
	}
	return urls;
}
