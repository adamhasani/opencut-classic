"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEditor } from "@/editor/use-editor";
import { createProjectFromCapcutTemplate } from "@/project/from-capcut-template";
import {
	formatTemplateDuration,
	formatUsageCount,
	type CapcutTemplateMeta,
} from "@/capcut/types";

interface DetailResponse {
	template?: CapcutTemplateMeta;
	error?: string;
}

interface SearchResponse {
	templates?: CapcutTemplateMeta[];
	source?: string;
	error?: string;
}

async function fetchTemplateDetail({
	url,
}: {
	url: string;
}): Promise<CapcutTemplateMeta> {
	const response = await fetch(
		`/api/capcut/detail?url=${encodeURIComponent(url)}`,
	);
	const data = (await response.json()) as DetailResponse;
	if (!response.ok || !data.template) {
		throw new Error(data.error ?? "Gagal membaca template CapCut.");
	}
	return data.template;
}

export function CapcutTemplateButton() {
	const [isOpen, setIsOpen] = useState(false);

	return (
		<>
			<Button
				size="lg"
				variant="outline"
				className="flex px-5 md:px-6"
				onClick={() => setIsOpen(true)}
			>
				<span className="text-sm font-medium">Template CapCut</span>
			</Button>
			<CapcutTemplateDialog isOpen={isOpen} onOpenChange={setIsOpen} />
		</>
	);
}

function CapcutTemplateDialog({
	isOpen,
	onOpenChange,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const router = useRouter();
	const [creatingId, setCreatingId] = useState<string | null>(null);

	const createFromMeta = async ({ meta }: { meta: CapcutTemplateMeta }) => {
		setCreatingId(meta.id);
		try {
			const { projectId } = await createProjectFromCapcutTemplate({ meta });
			await editor.project.loadAllProjects();
			onOpenChange(false);
			router.push(`/editor/${projectId}`);
			toast.success("Proyek tiruan dibuat", {
				description:
					"Struktur template sudah jadi slot kosong — isi tiap slot dengan klipmu sendiri di trek video utama.",
			});
		} catch (error) {
			toast.error("Gagal membuat proyek tiruan", {
				description:
					error instanceof Error ? error.message : "Silakan coba lagi",
			});
		} finally {
			setCreatingId(null);
		}
	};

	const createFromDetailUrl = async ({ url }: { url: string }) => {
		setCreatingId(url);
		try {
			const meta = await fetchTemplateDetail({ url });
			await createFromMeta({ meta });
		} catch (error) {
			toast.error("Gagal membaca template", {
				description:
					error instanceof Error ? error.message : "Silakan coba lagi",
			});
		} finally {
			setCreatingId(null);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-3xl">
				<DialogHeader>
					<DialogTitle>Tiru struktur template CapCut</DialogTitle>
					<DialogDescription>
						Cari template atau tempel link-nya. Yang ditiru hanya struktur
						publiknya — rasio, durasi total, dan jumlah slot klip. Proyek yang
						dibuat kosong; isi tiap slot dengan klipmu sendiri. Durasi tiap
						slot adalah perkiraan bagi rata karena CapCut hanya menampilkan
						durasi total.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<Tabs defaultValue="cari">
						<TabsList>
							<TabsTrigger value="cari">Cari</TabsTrigger>
							<TabsTrigger value="tempel">Tempel Link</TabsTrigger>
						</TabsList>
						<TabsContent value="cari">
							<SearchTab
								creatingId={creatingId}
								onPick={(meta) =>
									createFromDetailUrl({ url: meta.detailUrl })
								}
							/>
						</TabsContent>
						<TabsContent value="tempel">
							<PasteLinkTab
								creatingId={creatingId}
								onCreate={createFromMeta}
							/>
						</TabsContent>
					</Tabs>
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

function SearchTab({
	creatingId,
	onPick,
}: {
	creatingId: string | null;
	onPick: (meta: CapcutTemplateMeta) => void;
}) {
	const [keyword, setKeyword] = useState("");
	const [results, setResults] = useState<CapcutTemplateMeta[] | null>(null);
	const [source, setSource] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [isSearching, setIsSearching] = useState(false);

	const handleSearch = async () => {
		const query = keyword.trim();
		if (!query || isSearching) return;
		setIsSearching(true);
		setError(null);
		try {
			const response = await fetch(
				`/api/capcut/search?q=${encodeURIComponent(query)}`,
			);
			const data = (await response.json()) as SearchResponse;
			if (!response.ok) {
				throw new Error(data.error ?? "Pencarian gagal.");
			}
			setResults(data.templates ?? []);
			setSource(data.source ?? null);
		} catch (searchError) {
			setResults(null);
			setError(
				searchError instanceof Error
					? searchError.message
					: "Pencarian gagal.",
			);
		} finally {
			setIsSearching(false);
		}
	};

	return (
		<div className="flex flex-col gap-4 pt-4">
			<div className="flex gap-2">
				<Input
					placeholder="Kata kunci template, mis. dokumentasi"
					value={keyword}
					onChange={(event) => setKeyword(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") handleSearch();
					}}
				/>
				<Button onClick={handleSearch} disabled={isSearching}>
					{isSearching ? "Mencari..." : "Cari"}
				</Button>
			</div>

			{error && <p className="text-destructive text-sm">{error}</p>}

			{results !== null && results.length === 0 && (
				<p className="text-muted-foreground text-sm">
					Tidak ada template yang ditemukan untuk kata kunci ini.
				</p>
			)}

			{results !== null && results.length > 0 && (
				<>
					<p className="text-muted-foreground text-xs">
						{source === "search-index"
							? "Hasil dari indeks mesin pencari publik untuk halaman template CapCut."
							: "Hasil dari halaman jelajah publik CapCut."}{" "}
						Klik kartu untuk membuat proyek tiruannya.
					</p>
					<div className="grid max-h-[50vh] grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3">
						{results.map((template) => (
							<button
								key={template.id}
								type="button"
								className="group border-border bg-card hover:border-primary/60 flex flex-col overflow-hidden rounded-md border text-left transition-colors disabled:opacity-60"
								disabled={creatingId !== null}
								onClick={() => onPick(template)}
							>
								<div className="bg-muted relative aspect-[3/4] w-full">
									{template.coverUrl ? (
										<Image
											src={template.coverUrl}
											alt={template.title}
											fill
											className="object-cover"
											unoptimized
										/>
									) : null}
									<div className="absolute right-1.5 bottom-1.5 rounded-sm bg-black/60 px-1.5 py-0.5 text-[11px] font-semibold text-white">
										{formatTemplateDuration({
											durationMs: template.durationMs,
										})}
									</div>
								</div>
								<div className="flex flex-col gap-0.5 p-2">
									<span className="line-clamp-2 text-xs leading-snug font-medium">
										{template.title}
									</span>
									<span className="text-muted-foreground text-[11px]">
										{template.segmentCount
											? `${template.segmentCount} slot`
											: "slot tidak diketahui"}
										{template.usageCount
											? ` · ${formatUsageCount({ count: template.usageCount })} pemakaian`
											: ""}
									</span>
									<span className="text-primary text-[11px] font-medium">
										{creatingId === template.detailUrl
											? "Membuat proyek..."
											: "Buat proyek tiruan →"}
									</span>
								</div>
							</button>
						))}
					</div>
				</>
			)}
		</div>
	);
}

function PasteLinkTab({
	creatingId,
	onCreate,
}: {
	creatingId: string | null;
	onCreate: (args: { meta: CapcutTemplateMeta }) => void;
}) {
	const [link, setLink] = useState("");
	const [meta, setMeta] = useState<CapcutTemplateMeta | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [isFetching, setIsFetching] = useState(false);

	const handleFetch = async () => {
		const url = link.trim();
		if (!url || isFetching) return;
		setIsFetching(true);
		setError(null);
		setMeta(null);
		try {
			setMeta(await fetchTemplateDetail({ url }));
		} catch (fetchError) {
			setError(
				fetchError instanceof Error
					? fetchError.message
					: "Gagal membaca link template.",
			);
		} finally {
			setIsFetching(false);
		}
	};

	return (
		<div className="flex flex-col gap-4 pt-4">
			<div className="flex gap-2">
				<Input
					placeholder="Tempel link template, mis. https://www.capcut.com/tv2/..."
					value={link}
					onChange={(event) => setLink(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") handleFetch();
					}}
				/>
				<Button onClick={handleFetch} disabled={isFetching}>
					{isFetching ? "Membaca..." : "Ambil info"}
				</Button>
			</div>

			{error && <p className="text-destructive text-sm">{error}</p>}

			{meta && (
				<div className="border-border flex gap-4 rounded-md border p-3">
					{meta.coverUrl && (
						<div className="bg-muted relative aspect-[3/4] w-24 shrink-0 overflow-hidden rounded">
							<Image
								src={meta.coverUrl}
								alt={meta.title}
								fill
								className="object-cover"
								unoptimized
							/>
						</div>
					)}
					<div className="flex min-w-0 flex-1 flex-col gap-1">
						<h4 className="truncate text-sm font-semibold">{meta.title}</h4>
						{meta.authorName && (
							<p className="text-muted-foreground text-xs">
								Kreator: {meta.authorName}
							</p>
						)}
						<p className="text-muted-foreground text-xs">
							Durasi{" "}
							{formatTemplateDuration({ durationMs: meta.durationMs })} ·
							Rasio {meta.ratio ?? `${meta.width}×${meta.height}`} ·{" "}
							{meta.segmentCount} slot klip
							{meta.usageCount
								? ` · ${formatUsageCount({ count: meta.usageCount })} pemakaian`
								: ""}
						</p>
						<p className="text-muted-foreground text-xs">
							Proyek akan dibuat kosong dengan {meta.segmentCount} slot
							placeholder (durasi per slot perkiraan bagi rata). Isi dengan
							klipmu sendiri.
						</p>
						<div className="pt-1">
							<Button
								onClick={() => onCreate({ meta })}
								disabled={creatingId !== null}
							>
								{creatingId === meta.id
									? "Membuat proyek..."
									: "Buat proyek tiruan"}
							</Button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
