import type { FilePart } from "@sugabots/contracts";
import { cn } from "cn";
import { Download, FileIcon, FileSpreadsheet, FileText } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { extensionOf, type FileLook, fileLookOf, fileSizeLabel } from "@/lib/file-looks.ts";
import { CloseButton } from "@/ui/close-button.tsx";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from "@/ui/dialog.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { MiddleTruncated } from "@/ui/middle-truncated.tsx";

/**
 * Where an attached file is served, or undefined while it can't be yet, as
 * for a message still being sent.
 */
export type FileUrlOf = (fileId: string) => string | undefined;

/**
 * The files on a message, a person's or a bot's reply, under its words: its
 * images as pictures, each opening full size over the chat, then every other
 * file as a chip to download. A file not served yet shows without a link.
 */
export function MessageFiles({ files, urlOf }: { files: readonly FilePart[]; urlOf: FileUrlOf }) {
	const images = files.filter((file) => lookOf(file) === "image");
	const others = files.filter((file) => lookOf(file) !== "image");
	return (
		<div className="flex w-full flex-col items-start gap-1.5 pt-1.5">
			{images.length > 0 && <ImageGrid images={images} urlOf={urlOf} />}
			{others.length > 0 && (
				<ul className="m-0 flex w-full list-none flex-col gap-1.5 p-0 sm:flex-row sm:flex-wrap">
					{others.map((file) => (
						<li key={file.id} className="w-full sm:w-[300px]">
							<FileChip file={file} url={urlOf(file.id)} />
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function lookOf(file: FilePart): FileLook {
	return fileLookOf({ name: file.name, type: file.contentType });
}

/**
 * One image in a 4:3 frame up to 360 by 270, two side by side, or three to a
 * row, each tile 4:3 and the grid no wider than the chat it is in. Every image
 * is shown: the viewer opens one at a time, so one hidden behind a count could
 * not be opened. Tiles keep their size before their images load, so the
 * thread doesn't move as they arrive.
 */
function ImageGrid({ images, urlOf }: { images: readonly FilePart[]; urlOf: FileUrlOf }) {
	const [only] = images;
	if (images.length === 1 && only) {
		return (
			<div className="aspect-[4/3] w-full max-w-[360px]">
				<ImageTile file={only} url={urlOf(only.id)} fit="contain" />
			</div>
		);
	}
	return (
		<ul
			className={cn(
				"m-0 grid w-full list-none gap-1 p-0",
				images.length === 2 ? "max-w-[320px] grid-cols-2" : "max-w-[482px] grid-cols-3",
			)}
		>
			{images.map((file) => (
				<li key={file.id} className="aspect-[4/3]">
					<ImageTile file={file} url={urlOf(file.id)} fit="cover" />
				</li>
			))}
		</ul>
	);
}

/**
 * An image filling its frame, opening full size over the chat, with a
 * download button over its corner while it's hovered or focused. One the
 * browser can't draw, or not served yet, shows its name and a file icon
 * instead.
 */
function ImageTile({
	file,
	url,
	fit,
}: {
	file: FilePart;
	url: string | undefined;
	fit: "cover" | "contain";
}) {
	const [undrawable, setUndrawable] = useState(false);
	const frame =
		"flex size-full items-center justify-center overflow-hidden rounded-lg border border-border bg-tile";
	const standIn = (
		<span className="flex min-w-0 flex-col items-center gap-1 px-2 text-muted-foreground">
			<FileIcon aria-hidden size={18} />
			<MiddleTruncated text={file.name} className="max-w-full text-[11px]" />
		</span>
	);
	if (!url) return <div className={frame}>{standIn}</div>;
	return (
		<div className="group relative size-full">
			<Dialog>
				<DialogTrigger
					aria-label={`Open ${file.name}`}
					className={cn(frame, "focus-ring cursor-zoom-in")}
				>
					{undrawable ? (
						standIn
					) : (
						<img
							src={url}
							// The button names the image, so the picture isn't named twice.
							alt=""
							loading="lazy"
							onError={() => setUndrawable(true)}
							className={cn("block size-full", fit === "cover" ? "object-cover" : "object-contain")}
						/>
					)}
				</DialogTrigger>
				<ImageViewer file={file} url={url} drawable={!undrawable} />
			</Dialog>
			<DownloadButton
				file={file}
				url={url}
				variant="round"
				className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
			/>
		</div>
	);
}

/**
 * The image as large as the window allows, over the chat, with its name and
 * a way to download it. One the browser can't draw says so, and can still be
 * downloaded.
 */
function ImageViewer({ file, url, drawable }: { file: FilePart; url: string; drawable: boolean }) {
	// Focus starts on the picture, not the first button, whose tooltip would
	// otherwise open and take the first Escape.
	const picture = useRef<HTMLDivElement>(null);
	return (
		<DialogContent
			initialFocus={picture}
			showCloseButton={false}
			className="inset-4 flex w-auto max-w-none translate-x-0 translate-y-0 flex-col gap-3 p-3 sm:inset-10 sm:max-w-none"
		>
			<div className="flex items-center gap-2 pl-1">
				<DialogTitle className="min-w-0 flex-1">
					<MiddleTruncated text={file.name} />
				</DialogTitle>
				<DownloadButton file={file} url={url} variant="round" />
				<CloseButton render={<DialogClose />} />
			</div>
			<div
				ref={picture}
				tabIndex={-1}
				className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-stage outline-none"
			>
				{drawable ? (
					<img src={url} alt={file.name} className="block max-h-full max-w-full object-contain" />
				) : (
					<p className="m-0 px-4 text-center text-muted-foreground text-sm">
						This picture can't be shown here. Download it to open it.
					</p>
				)}
			</div>
		</DialogContent>
	);
}

/** Downloads the file under its own name. */
function DownloadButton({
	file,
	url,
	variant,
	size,
	className,
}: {
	file: FilePart;
	url: string;
	variant?: "quiet" | "round";
	size?: "default" | "lg";
	className?: string;
}) {
	return (
		<IconButton
			label={`Download ${file.name}`}
			variant={variant}
			size={size}
			className={className}
			render={<a href={url} download={file.name} />}
		>
			<Download aria-hidden />
		</IconButton>
	);
}

/** A file that isn't a picture: its kind, name and size, and a way to download it once it can be. */
function FileChip({ file, url }: { file: FilePart; url: string | undefined }) {
	const extension = extensionOf(file.name).toUpperCase();
	return (
		<div className="flex w-full items-center gap-2.5 rounded-[10px] border border-border bg-card py-2 pr-2 pl-2.5">
			<span className="grid size-8 shrink-0 place-items-center rounded-md bg-tile text-soft-foreground">
				<FileLookIcon look={lookOf(file)} />
			</span>
			<span className="flex min-h-[30px] min-w-0 flex-1 flex-col justify-center gap-px">
				<MiddleTruncated text={file.name} className="font-medium text-[14px] text-foreground" />
				<span className="text-[12px] text-subtle-foreground">
					{extension ? `${extension} · ` : ""}
					{fileSizeLabel(file.size)}
				</span>
			</span>
			{url && <DownloadButton file={file} url={url} size="lg" />}
		</div>
	);
}

function FileLookIcon({ look }: { look: FileLook }): ReactNode {
	if (look === "pdf") return <FileText aria-hidden size={16} />;
	if (look === "sheet") return <FileSpreadsheet aria-hidden size={16} />;
	return <FileIcon aria-hidden size={16} />;
}
