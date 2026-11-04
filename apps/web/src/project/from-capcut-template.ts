import { DEFAULT_BACKGROUND_COLOR } from "@/background/color";
import { DEFAULT_CANVAS_PRESETS } from "@/canvas/sizes";
import type { CapcutTemplateMeta } from "@/capcut/types";
import type { TProject } from "@/project/types";
import { storageService } from "@/services/storage/service";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { buildTextElement } from "@/timeline/element-utils";
import {
	buildDefaultScene,
	getProjectDurationFromScenes,
} from "@/timeline/scenes";
import type { TextTrack } from "@/timeline/types";
import { generateUUID } from "@/utils/id";
import { mediaTimeFromSeconds } from "@/wasm";

/**
 * Build an empty OpenCut project that mirrors the *structure* of a CapCut
 * template: same canvas ratio and total duration, with one labelled
 * placeholder segment per clip slot on a text track. The user fills the
 * slots with their own clips on the main video track.
 *
 * Only the template's public page metadata is used (title, duration,
 * ratio, slot count). CapCut does not publish per-slot durations, so slot
 * lengths are an even split of the total — the track name says so.
 *
 * Per-slot timing uses cumulative rounding so the slots always add up to
 * exactly the template's total duration.
 */

const MAX_SLOTS = 200;

function gcd(a: number, b: number): number {
	return b === 0 ? a : gcd(b, a % b);
}

function resolveCanvasSize({
	meta,
}: {
	meta: CapcutTemplateMeta;
}): { width: number; height: number } {
	let width = meta.width;
	let height = meta.height;
	if ((!width || !height) && meta.ratio) {
		const parts = meta.ratio.split(":").map((part) => Number(part));
		if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
			width = parts[0];
			height = parts[1];
		}
	}
	if (!width || !height) {
		return { width: 1080, height: 1920 };
	}

	const divisor = gcd(Math.round(width), Math.round(height));
	const ratioW = Math.round(width) / divisor;
	const ratioH = Math.round(height) / divisor;

	const preset = DEFAULT_CANVAS_PRESETS.find((size) => {
		const presetDivisor = gcd(size.width, size.height);
		return (
			size.width / presetDivisor === ratioW &&
			size.height / presetDivisor === ratioH
		);
	});
	if (preset) {
		return { width: preset.width, height: preset.height };
	}

	// Custom ratio: scale so the long side is 1920, keeping even dimensions.
	const scale = 1920 / Math.max(width, height);
	return {
		width: Math.max(2, Math.round((width * scale) / 2) * 2),
		height: Math.max(2, Math.round((height * scale) / 2) * 2),
	};
}

export function slotBoundariesSeconds({
	totalSeconds,
	slotCount,
}: {
	totalSeconds: number;
	slotCount: number;
}): Array<{ start: number; duration: number }> {
	const slots: Array<{ start: number; duration: number }> = [];
	for (let index = 0; index < slotCount; index++) {
		const start = Math.round((index * totalSeconds * 1000) / slotCount) / 1000;
		const end =
			Math.round(((index + 1) * totalSeconds * 1000) / slotCount) / 1000;
		slots.push({ start, duration: Math.max(0.1, end - start) });
	}
	return slots;
}

export async function createProjectFromCapcutTemplate({
	meta,
}: {
	meta: CapcutTemplateMeta;
}): Promise<{ projectId: string }> {
	if (!meta.segmentCount || meta.segmentCount < 1) {
		throw new Error("Jumlah slot template tidak tersedia.");
	}
	if (meta.durationMs <= 0) {
		throw new Error("Durasi template tidak tersedia.");
	}
	const slotCount = Math.min(meta.segmentCount, MAX_SLOTS);
	const totalSeconds = meta.durationMs / 1000;
	const { width: canvasWidth, height: canvasHeight } = resolveCanvasSize({
		meta,
	});

	const boundaries = slotBoundariesSeconds({ totalSeconds, slotCount });
	const slotTrack: TextTrack = {
		id: generateUUID(),
		name: `Slot template — durasi per slot perkiraan bagi rata (${slotCount} slot)`,
		type: "text",
		elements: [],
		hidden: false,
	};
	for (const [index, slot] of boundaries.entries()) {
		const created = buildTextElement({
			raw: {
				name: `Slot ${index + 1}`,
				duration: mediaTimeFromSeconds({ seconds: slot.duration }),
				params: {
					content: `Slot ${index + 1}`,
					fontSize: 9,
					textAlign: "center",
					"transform.positionX": 0,
					"transform.positionY": 0,
				},
			},
			startTime: mediaTimeFromSeconds({ seconds: slot.start }),
		});
		if (created.type === "text") {
			slotTrack.elements.push({ ...created, id: generateUUID() });
		}
	}

	const defaultScene = buildDefaultScene({
		name: "Struktur template",
		isMain: true,
	});
	const scene = {
		...defaultScene,
		tracks: {
			...defaultScene.tracks,
			overlay: [slotTrack],
		},
	};

	const isPresetSize = DEFAULT_CANVAS_PRESETS.some(
		(size) => size.width === canvasWidth && size.height === canvasHeight,
	);
	const now = new Date();
	const scenes = [scene];
	const projectId = generateUUID();
	const project: TProject = {
		metadata: {
			id: projectId,
			name: `Tiru: ${meta.title}`,
			duration: getProjectDurationFromScenes({ scenes }),
			createdAt: now,
			updatedAt: now,
		},
		scenes,
		currentSceneId: scene.id,
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: canvasWidth, height: canvasHeight },
			canvasSizeMode: isPresetSize ? "preset" : "custom",
			lastCustomCanvasSize: isPresetSize
				? null
				: { width: canvasWidth, height: canvasHeight },
			originalCanvasSize: null,
			background: { type: "color", color: DEFAULT_BACKGROUND_COLOR },
		},
		version: CURRENT_PROJECT_VERSION,
	};

	await storageService.saveProject({ project });
	return { projectId };
}
