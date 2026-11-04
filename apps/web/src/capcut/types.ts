/**
 * Public metadata of a CapCut template, as displayed on its public
 * template-detail / explore pages. Only display information is modelled
 * here — never template project data or creator assets.
 */
export interface CapcutTemplateMeta {
	/** CapCut template id (numeric string). */
	id: string;
	title: string;
	coverUrl: string | null;
	authorName: string | null;
	/** Total template duration in milliseconds. */
	durationMs: number;
	/** Aspect ratio label such as "9:16", when the page exposes one. */
	ratio: string | null;
	/** Template video width in pixels, when exposed. */
	width: number | null;
	/** Template video height in pixels, when exposed. */
	height: number | null;
	/** Number of clip slots the template asks the user to fill. */
	segmentCount: number | null;
	/** How many times the template has been used, when exposed. */
	usageCount: number | null;
	/** Canonical public detail-page URL. */
	detailUrl: string;
}

export function formatTemplateDuration({
	durationMs,
}: {
	durationMs: number;
}): string {
	const totalSeconds = Math.round(durationMs / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatUsageCount({ count }: { count: number }): string {
	return count.toLocaleString("id-ID");
}
