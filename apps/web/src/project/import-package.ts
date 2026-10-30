import { unzipSync } from "fflate";
import type { FrameRate } from "opencut-wasm";
import { DEFAULT_BACKGROUND_COLOR } from "@/background/color";
import { DEFAULT_CANVAS_PRESETS } from "@/canvas/sizes";
import type { MediaAsset, MediaType } from "@/media/types";
import { processMediaAssets } from "@/media/processing";
import type { TProject } from "@/project/types";
import { storageService } from "@/services/storage/service";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { buildElementFromMedia, buildTextElement } from "@/timeline/element-utils";
import {
	buildDefaultScene,
	getProjectDurationFromScenes,
} from "@/timeline/scenes";
import { DEFAULTS } from "@/timeline/defaults";
import type {
	AudioTrack,
	SceneTracks,
	TextTrack,
	TimelineElement,
	VideoTrack,
} from "@/timeline/types";
import { FONT_SIZE_SCALE_REFERENCE } from "@/text/typography";
import { generateUUID } from "@/utils/id";
import { mediaTimeFromSeconds } from "@/wasm";

/**
 * Import of an "opencut-project-package" (.zip): a manifest.json plus a
 * media/ folder describing a project in plain seconds/pixels, converted here
 * into a regular OpenCut project stored through the normal storage service,
 * so it shows up in /projects and opens in the editor like any other project.
 *
 * Track order in the manifest is bottom-to-top: the lowest video track
 * becomes the scene's main track, remaining visual tracks become overlay
 * tracks (which the app stores top-first), audio tracks go to the audio lane.
 */

const PACKAGE_FORMAT = "opencut-project-package";
const PACKAGE_VERSION = 1;

interface PackageTextStyle {
	fontSize: number;
	bold?: boolean;
	color?: string;
	align?: string;
	y: number;
}

interface PackageTrack {
	kind: "video" | "audio" | "text";
	name: string;
	textStyle?: PackageTextStyle;
}

interface PackageAsset {
	id: string;
	file: string;
	type: MediaType;
}

interface PackageMediaElement {
	track: number;
	asset: string;
	start: number;
	duration: number;
	x?: number;
	y?: number;
	w?: number;
	h?: number;
}

interface PackageTextElement {
	track: number;
	text: string;
	start: number;
	duration: number;
}

type PackageElement = PackageMediaElement | PackageTextElement;

interface ProjectPackageManifest {
	format: string;
	version: number;
	project: { name: string; width: number; height: number; fps: number };
	tracks: PackageTrack[];
	assets: PackageAsset[];
	elements: PackageElement[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest({ raw }: { raw: unknown }): ProjectPackageManifest {
	if (!isRecord(raw)) {
		throw new Error("Invalid package: manifest.json is not a JSON object");
	}
	if (raw.format !== PACKAGE_FORMAT) {
		throw new Error(
			`Invalid package: expected format "${PACKAGE_FORMAT}"`,
		);
	}
	if (raw.version !== PACKAGE_VERSION) {
		throw new Error(
			`Unsupported package version: ${String(raw.version)} (expected ${PACKAGE_VERSION})`,
		);
	}
	if (
		!isRecord(raw.project) ||
		typeof raw.project.name !== "string" ||
		typeof raw.project.width !== "number" ||
		typeof raw.project.height !== "number" ||
		typeof raw.project.fps !== "number"
	) {
		throw new Error("Invalid package: manifest project is incomplete");
	}
	if (!Array.isArray(raw.tracks) || !Array.isArray(raw.assets) || !Array.isArray(raw.elements)) {
		throw new Error("Invalid package: tracks, assets and elements must be arrays");
	}
	for (const track of raw.tracks as Array<Record<string, unknown>>) {
		if (
			!isRecord(track) ||
			(track.kind !== "video" && track.kind !== "audio" && track.kind !== "text") ||
			typeof track.name !== "string"
		) {
			throw new Error("Invalid package: malformed track entry");
		}
	}
	for (const asset of raw.assets as Array<Record<string, unknown>>) {
		if (
			!isRecord(asset) ||
			typeof asset.id !== "string" ||
			typeof asset.file !== "string" ||
			(asset.type !== "image" && asset.type !== "audio" && asset.type !== "video")
		) {
			throw new Error("Invalid package: malformed asset entry");
		}
	}
	return raw as unknown as ProjectPackageManifest;
}

const MIME_BY_EXTENSION: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	svg: "image/svg+xml",
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	wav: "audio/wav",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	ogg: "audio/ogg",
};

function mimeTypeForFile({ fileName }: { fileName: string }): string {
	const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
	return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function toFrameRate({ fps }: { fps: number }): FrameRate {
	if (Number.isInteger(fps)) {
		return { numerator: fps, denominator: 1 };
	}
	return { numerator: Math.round(fps * 1000), denominator: 1000 };
}

type BuiltTrack = VideoTrack | AudioTrack | TextTrack;

function buildEmptyTrack({ track }: { track: PackageTrack }): BuiltTrack {
	const id = generateUUID();
	switch (track.kind) {
		case "video":
			return { id, name: track.name, type: "video", elements: [], muted: false, hidden: false };
		case "audio":
			return { id, name: track.name, type: "audio", elements: [], muted: false };
		case "text":
			return { id, name: track.name, type: "text", elements: [], hidden: false };
	}
}

export async function importProjectPackage({
	file,
}: {
	file: File;
}): Promise<{ projectId: string }> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	let entries: Record<string, Uint8Array>;
	try {
		entries = unzipSync(bytes);
	} catch {
		throw new Error("Invalid package: not a readable .zip file");
	}

	const manifestKey = Object.keys(entries).find(
		(key) => key === "manifest.json" || key.endsWith("/manifest.json"),
	);
	if (!manifestKey) {
		throw new Error("Invalid package: manifest.json not found");
	}
	const packagePrefix = manifestKey.slice(
		0,
		manifestKey.length - "manifest.json".length,
	);

	let manifestJson: unknown;
	try {
		manifestJson = JSON.parse(new TextDecoder().decode(entries[manifestKey]));
	} catch {
		throw new Error("Invalid package: manifest.json is not valid JSON");
	}
	const manifest = parseManifest({ raw: manifestJson });

	const { width: canvasWidth, height: canvasHeight } = manifest.project;
	const projectId = generateUUID();

	try {
		// Register media through the same processing + storage path the app
		// uses for manual imports (metadata extraction, OPFS file store,
		// per-project metadata store).
		const assetByPackageId = new Map<string, MediaAsset>();
		for (const packageAsset of manifest.assets) {
			const data =
				entries[`${packagePrefix}${packageAsset.file}`] ??
				entries[packageAsset.file];
			if (!data) {
				throw new Error(`Invalid package: missing media file ${packageAsset.file}`);
			}
			const fileName = packageAsset.file.split("/").pop() ?? packageAsset.file;
			// Copy into a fresh ArrayBuffer-backed array for the File constructor.
			const fileBytes = new Uint8Array(data);
			const mediaFile = new File([fileBytes], fileName, {
				type: mimeTypeForFile({ fileName }),
			});
			const [processed] = await processMediaAssets({ files: [mediaFile] });
			if (!processed) {
				throw new Error(`Could not process media file: ${packageAsset.file}`);
			}
			if (processed.type !== packageAsset.type) {
				throw new Error(
					`Media type mismatch for ${packageAsset.file}: manifest says ${packageAsset.type}, file is ${processed.type}`,
				);
			}
			const asset: MediaAsset = { ...processed, id: generateUUID() };
			await storageService.saveMediaAsset({ projectId, mediaAsset: asset });
			assetByPackageId.set(packageAsset.id, asset);
		}

		const builtTracks = manifest.tracks.map((track) => buildEmptyTrack({ track }));

		for (const element of manifest.elements) {
			const packageTrack = manifest.tracks[element.track];
			const builtTrack = builtTracks[element.track];
			if (!packageTrack || !builtTrack) {
				throw new Error(`Invalid package: element references unknown track ${element.track}`);
			}
			const startTime = mediaTimeFromSeconds({ seconds: element.start });
			const duration = mediaTimeFromSeconds({ seconds: element.duration });

			if ("text" in element) {
				if (packageTrack.kind !== "text" || builtTrack.type !== "text") {
					throw new Error("Invalid package: text element on a non-text track");
				}
				const style = packageTrack.textStyle;
				// The manifest font size is in canvas pixels; the app's fontSize
				// param is scaled by canvasHeight / FONT_SIZE_SCALE_REFERENCE at
				// render time, so convert back into param units.
				const fontSizePx = style?.fontSize ?? 48;
				const fontSizeParam =
					(fontSizePx * FONT_SIZE_SCALE_REFERENCE) / canvasHeight;
				const align =
					style?.align === "left" || style?.align === "right"
						? style.align
						: "center";
				// Text blocks are anchored by their center: full-width placement
				// means the block edge sits on the canvas edge for left/right
				// alignment, and the block top sits at the style's y.
				const positionX =
					align === "left"
						? -canvasWidth / 2
						: align === "right"
							? canvasWidth / 2
							: 0;
				const lineCount = Math.max(1, element.text.split("\n").length);
				const blockHeight =
					lineCount * fontSizePx * DEFAULTS.text.lineHeight;
				const positionY =
					(style?.y ?? canvasHeight / 2) + blockHeight / 2 - canvasHeight / 2;

				const created = buildTextElement({
					raw: {
						duration,
						params: {
							content: element.text,
							fontSize: fontSizeParam,
							color: style?.color ?? "#ffffff",
							textAlign: align,
							fontWeight: style?.bold ? "bold" : "normal",
							"transform.positionX": positionX,
							"transform.positionY": positionY,
						},
					},
					startTime,
				});
				if (created.type === "text") {
					builtTrack.elements.push({ ...created, id: generateUUID() });
				}
				continue;
			}

			const asset = assetByPackageId.get(element.asset);
			if (!asset) {
				throw new Error(`Invalid package: element references unknown asset ${element.asset}`);
			}
			const expectedTrackKind = asset.type === "audio" ? "audio" : "video";
			if (packageTrack.kind !== expectedTrackKind || builtTrack.type !== expectedTrackKind) {
				throw new Error(
					`Invalid package: ${asset.type} element on a ${packageTrack.kind} track`,
				);
			}

			const created = buildElementFromMedia({
				mediaId: asset.id,
				mediaType: asset.type,
				name: asset.name,
				duration,
				startTime,
			});

			if (created.type === "video" || created.type === "audio") {
				if (asset.duration != null) {
					created.sourceDuration = mediaTimeFromSeconds({
						seconds: asset.duration,
					});
				}
			}

			if (created.type === "video" || created.type === "image") {
				// Invert the renderer's contain-fit geometry (see
				// services/renderer/resolve.ts): the rendered box is the source
				// scaled by containScale * scale and centered at the canvas
				// center + position. The manifest box is top-left + size.
				const sourceWidth = asset.width ?? canvasWidth;
				const sourceHeight = asset.height ?? canvasHeight;
				const containScale = Math.min(
					canvasWidth / sourceWidth,
					canvasHeight / sourceHeight,
				);
				const boxWidth = element.w ?? sourceWidth * containScale;
				const boxHeight = element.h ?? sourceHeight * containScale;
				const boxX = element.x ?? (canvasWidth - boxWidth) / 2;
				const boxY = element.y ?? (canvasHeight - boxHeight) / 2;
				created.params = {
					...created.params,
					"transform.scaleX": boxWidth / (sourceWidth * containScale),
					"transform.scaleY": boxHeight / (sourceHeight * containScale),
					"transform.positionX": boxX + boxWidth / 2 - canvasWidth / 2,
					"transform.positionY": boxY + boxHeight / 2 - canvasHeight / 2,
				};
			}

			const timelineElement: TimelineElement = {
				...created,
				id: generateUUID(),
			};
			if (builtTrack.type === "video") {
				if (timelineElement.type === "video" || timelineElement.type === "image") {
					builtTrack.elements.push(timelineElement);
				}
			} else if (builtTrack.type === "audio") {
				if (timelineElement.type === "audio") {
					builtTrack.elements.push(timelineElement);
				}
			}
		}

		const mainIndex = manifest.tracks.findIndex((track) => track.kind === "video");
		const defaultScene = buildDefaultScene({ name: "Main scene", isMain: true });
		const overlayTracks: SceneTracks["overlay"] = [];
		const audioTracks: AudioTrack[] = [];
		builtTracks.forEach((builtTrack, index) => {
			if (index === mainIndex) return;
			if (builtTrack.type === "audio") {
				audioTracks.push(builtTrack);
			} else {
				// Overlay tracks are stored top-first; manifest order is
				// bottom-to-top, so visual overlays are collected in reverse.
				overlayTracks.unshift(builtTrack);
			}
		});
		const mainCandidate = mainIndex >= 0 ? builtTracks[mainIndex] : undefined;
		const scene = {
			...defaultScene,
			tracks: {
				overlay: overlayTracks,
				main:
					mainCandidate && mainCandidate.type === "video"
						? mainCandidate
						: defaultScene.tracks.main,
				audio: audioTracks,
			},
		};

		const isPresetSize = DEFAULT_CANVAS_PRESETS.some(
			(size) => size.width === canvasWidth && size.height === canvasHeight,
		);
		const now = new Date();
		const scenes = [scene];
		const project: TProject = {
			metadata: {
				id: projectId,
				name: manifest.project.name,
				duration: getProjectDurationFromScenes({ scenes }),
				createdAt: now,
				updatedAt: now,
			},
			scenes,
			currentSceneId: scene.id,
			settings: {
				fps: toFrameRate({ fps: manifest.project.fps }),
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
	} catch (error) {
		// Roll back any media already stored for this never-created project.
		await storageService
			.deleteProjectMedia({ projectId })
			.catch(() => undefined);
		throw error;
	}
}
