import { MAX_ATTACHMENT_MEGABYTES, MAX_ATTACHMENTS_PER_MESSAGE } from "@sugabots/contracts";
import { cn } from "cn";
import { CircleAlert, FileIcon, Info, RotateCcw, X } from "lucide-react";
import {
	type CSSProperties,
	type RefObject,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { AttachmentUpload, ComposerAttachment } from "@/lib/composer-attachments.ts";
import { extensionOf, type FileLook, fileLookOf } from "@/lib/file-looks.ts";
import { listNames } from "@/lib/name-list.ts";
import { MiddleTruncated } from "@/ui/middle-truncated.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/**
 * The files attached to the message being written, as thumbnails above its
 * text, in the order attached. It wraps, and past two rows scrolls with the
 * third peeking in; on a phone it is one row that scrolls sideways. Beneath
 * it, why any file failed, announced as it fails. Removing a chip from the
 * keyboard moves the focus to the next chip's remove button, else the one
 * before, else to the draft through `focusDraft`.
 */
export function AttachmentTray({
	items,
	onRemove,
	onRetry,
	focusDraft,
}: {
	items: readonly ComposerAttachment[];
	onRemove: (key: string) => void;
	onRetry: (key: string) => void;
	focusDraft: () => void;
}) {
	const tray = useRef<HTMLUListElement>(null);
	const overflowing = useOverflowsVertically(tray, items.length);
	const failureIdPrefix = useId();
	const failures = failureNotesOf(items);
	const failureIdOf = (key: string) => {
		const index = failures.findIndex((note) => note.keys.includes(key));
		return index === -1 ? undefined : `${failureIdPrefix}-${index}`;
	};

	function removeAt(index: number, key: string): void {
		const removeButtons = [
			...(tray.current?.querySelectorAll<HTMLButtonElement>("[data-remove-chip]") ?? []),
		];
		const button = removeButtons[index];
		// Only from the keyboard: a tap on a phone would otherwise raise its keyboard for the draft.
		if (button && button === document.activeElement && button.matches(":focus-visible")) {
			const neighbour = removeButtons[index + 1] ?? removeButtons[index - 1];
			if (neighbour) neighbour.focus();
			else focusDraft();
		}
		onRemove(key);
	}

	return (
		<>
			{items.length > 0 && (
				<ul
					ref={tray}
					aria-label="Attached files"
					className={cn(
						"m-0 flex max-h-[206px] list-none flex-wrap gap-2 overflow-y-auto px-2.5 pt-2.5",
						overflowing && "mask-b-from-82% pb-2.5",
						"max-sm:max-h-none max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:overflow-y-hidden max-sm:mask-none max-sm:px-2 max-sm:pt-2 max-sm:pb-0",
					)}
				>
					{items.map((attachment, index) => (
						<AttachmentChip
							key={attachment.key}
							attachment={attachment}
							failureId={failureIdOf(attachment.key)}
							onRemove={() => removeAt(index, attachment.key)}
							onRetry={() => onRetry(attachment.key)}
						/>
					))}
				</ul>
			)}
			<div role="status" className="flex flex-col gap-1 px-3 pt-2 text-[13px] empty:hidden">
				{failures.map((note, index) => (
					<p
						key={note.reason}
						id={`${failureIdPrefix}-${index}`}
						className="m-0 flex min-w-0 items-start gap-2 text-soft-foreground"
					>
						<CircleAlert
							aria-hidden
							size={15}
							strokeWidth={2.2}
							className="mt-px shrink-0 text-destructive-text"
						/>
						<span className="min-w-0 [overflow-wrap:anywhere]">
							<span className="font-medium text-foreground">{note.names}</span>: {note.reason}
						</span>
					</p>
				))}
			</div>
		</>
	);
}

/** The failed files, one note for each reason, naming the files it applies to. */
function failureNotesOf(
	items: readonly ComposerAttachment[],
): { reason: string; names: string; keys: string[] }[] {
	const byReason = new Map<string, ComposerAttachment[]>();
	for (const item of items) {
		const reason = failureReasonOf(item.upload);
		if (reason) byReason.set(reason, [...(byReason.get(reason) ?? []), item]);
	}
	return [...byReason].map(([reason, failed]) => ({
		reason,
		names: listNames(failed.map(({ file }) => file.name)),
		keys: failed.map(({ key }) => key),
	}));
}

const TOO_LARGE_REASON = `Too large. ${MAX_ATTACHMENT_MEGABYTES} MB at most.`;

function failureReasonOf(upload: AttachmentUpload): string | undefined {
	if (upload.state === "tooLarge") return TOO_LARGE_REASON;
	if (upload.state === "failed") return upload.reason;
	return undefined;
}

/** Says how many files of the latest batch were left out for going over the limit. */
export function LeftOutNote({ count }: { count: number }) {
	return (
		<div
			role="status"
			className="flex items-center gap-2 px-3 pt-2.5 text-[13px] text-soft-foreground empty:hidden"
		>
			{count > 0 && (
				<>
					<Info
						aria-hidden
						size={15}
						strokeWidth={2.2}
						className="shrink-0 text-muted-foreground"
					/>
					<span>
						{count === 1 ? "1 file wasn't added." : `${count} files weren't added.`} A message can
						have {MAX_ATTACHMENTS_PER_MESSAGE} at most.
					</span>
				</>
			)}
		</div>
	);
}

/**
 * One attached file: a thumbnail of an image, or a page or icon for its type
 * with a badge naming it. Pointing at it, or focusing its buttons, shows its
 * name and how its upload stands over the thumbnail, and its remove button.
 * A failure that could go differently offers Retry; any other offers only
 * remove. `failureId` names the element saying why it failed, which both
 * buttons point to.
 */
export function AttachmentChip({
	attachment: { file, upload },
	failureId,
	onRemove,
	onRetry,
}: {
	attachment: ComposerAttachment;
	failureId?: string;
	onRemove: () => void;
	onRetry: () => void;
}) {
	const look = fileLookOf(file);
	const status = uploadStatusOf(upload);
	const failed = upload.state === "failed" || upload.state === "tooLarge";
	const retryable = upload.state === "failed" && upload.retryable;
	return (
		<li
			title={status ? `${file.name} · ${status}` : file.name}
			className={cn(
				"group relative block size-20 shrink-0 overflow-hidden rounded-[10px] border has-focus-visible:border-primary-tint-border max-sm:size-[72px]",
				failed ? "border-destructive/50 bg-destructive-hover" : "border-border-strong bg-chip",
			)}
		>
			{failed ? (
				// Retry takes the alert's place.
				!retryable && (
					<span className="absolute inset-0 grid place-items-center pb-3.5 text-destructive-text">
						<CircleAlert aria-hidden size={18} strokeWidth={2.2} />
					</span>
				)
			) : (
				<FilePreview file={file} look={look} dimmed={upload.state === "uploading"} />
			)}
			{failed ? (
				<span className="absolute inset-x-0 bottom-0 flex h-[22px] items-center justify-center border-destructive/30 border-t bg-destructive-hover font-medium text-[10px] text-destructive-text transition-opacity group-focus-within:opacity-0 group-hover:opacity-0">
					{upload.state === "tooLarge" ? "Too large" : "Failed"}
				</span>
			) : (
				look !== "image" && <TypeBadge file={file} look={look} />
			)}
			{retryable && (
				<Tooltip label="Retry" side="top">
					<button
						type="button"
						aria-label={`Retry ${file.name}`}
						aria-describedby={failureId}
						onClick={onRetry}
						className="focus-ring absolute top-1/2 left-1/2 z-[2] grid size-8 -translate-x-1/2 -translate-y-[70%] place-items-center rounded-full bg-hover text-foreground transition-colors hover:bg-hover-strong"
					>
						<RotateCcw aria-hidden size={16} strokeWidth={2.4} />
					</button>
				</Tooltip>
			)}
			<span className="pointer-events-none absolute inset-0 flex flex-col justify-end gap-0.5 bg-linear-to-b from-20% from-transparent to-75% to-background/92 px-[7px] py-1.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
				<MiddleTruncated
					text={file.name}
					className="font-medium text-[11px] text-foreground leading-[1.3]"
				/>
				{status && (
					<span
						className={cn(
							"text-[10.5px] leading-[1.25]",
							failed ? "text-destructive-text" : "text-soft-foreground",
						)}
					>
						{status}
					</span>
				)}
			</span>
			<Tooltip label="Remove" side="top">
				<button
					type="button"
					aria-label={`Remove ${file.name}`}
					aria-describedby={failureId}
					data-remove-chip
					onClick={onRemove}
					className="focus-ring absolute top-1 right-1 z-[3] grid size-6 place-items-center rounded-full bg-background/85 text-foreground opacity-0 transition-opacity hover:bg-background focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
				>
					<X aria-hidden size={12} strokeWidth={2.4} />
				</button>
			</Tooltip>
			{upload.state === "uploading" && (
				<UploadProgress name={file.name} fraction={upload.progress} />
			)}
		</li>
	);
}

function uploadStatusOf(upload: AttachmentUpload): string | undefined {
	switch (upload.state) {
		case "uploading":
			return `Uploading ${Math.round(upload.progress * 100)}%`;
		case "tooLarge":
			return TOO_LARGE_REASON;
		case "failed":
			return upload.retryable ? "Upload failed" : "Can't upload";
		case "uploaded":
			return undefined;
	}
}

/** What fills the chip: the image itself, a page drawn for a document or sheet, or a file icon. */
function FilePreview({ file, look, dimmed }: { file: File; look: FileLook; dimmed: boolean }) {
	const fade = cn("transition-opacity", dimmed && "opacity-45");
	if (look === "image") return <ImageThumbnail file={file} className={fade} />;
	if (look === "pdf") {
		return (
			<span
				className={cn(
					"absolute inset-[9px_14px_-6px] flex flex-col gap-1 rounded-[3px] bg-file-page px-[7px] py-2",
					fade,
				)}
			>
				<i className="mb-0.5 block h-[5px] w-[62%] rounded-sm bg-file-page-heading" />
				<i className="block h-[3px] rounded-sm bg-file-page-line" />
				<i className="block h-[3px] rounded-sm bg-file-page-line" />
				<i className="block h-[3px] w-[70%] rounded-sm bg-file-page-line" />
				<i className="block h-[3px] rounded-sm bg-file-page-line" />
				<i className="block h-[3px] w-[70%] rounded-sm bg-file-page-line" />
			</span>
		);
	}
	if (look === "sheet") {
		return (
			<span
				style={SHEET_GRID}
				className={cn("absolute inset-[9px_10px_-6px] rounded-[3px] bg-file-page", fade)}
			/>
		);
	}
	return (
		<span className={cn("absolute inset-0 grid place-items-center text-muted-foreground", fade)}>
			<FileIcon aria-hidden size={18} strokeWidth={2} />
		</span>
	);
}

/** Ruled lines and columns, as a spreadsheet's page is drawn. */
const SHEET_GRID: CSSProperties = {
	backgroundImage:
		"linear-gradient(var(--file-page-line) 1px, transparent 1px), linear-gradient(90deg, var(--file-page-line) 1px, transparent 1px)",
	backgroundSize: "100% 9px, 18px 100%",
	backgroundPosition: "0 8px, -1px 0",
};

/**
 * The image, cropped to fill the chip. The address it is read from lasts
 * only while it is shown. One the browser cannot draw shows a file icon.
 */
function ImageThumbnail({ file, className }: { file: File; className: string }) {
	const [address, setAddress] = useState<string>();
	const [broken, setBroken] = useState(false);
	useEffect(() => {
		const created = URL.createObjectURL(file);
		setAddress(created);
		return () => URL.revokeObjectURL(created);
	}, [file]);
	if (broken) {
		return (
			<span
				className={cn("absolute inset-0 grid place-items-center text-muted-foreground", className)}
			>
				<FileIcon aria-hidden size={18} strokeWidth={2} />
			</span>
		);
	}
	return (
		address && (
			<img
				src={address}
				alt=""
				onError={() => setBroken(true)}
				className={cn("absolute inset-0 size-full object-cover", className)}
			/>
		)
	);
}

/** The file's type, from its extension, at the chip's foot: green for a sheet, grey for any other. */
function TypeBadge({ file, look }: { file: File; look: Exclude<FileLook, "image"> }) {
	return (
		<span
			className={cn(
				"absolute bottom-[5px] left-[5px] flex h-4 max-w-[calc(100%-10px)] items-center truncate rounded-[4px] px-[5px] font-semibold text-[10px] text-primary-foreground tracking-[0.03em] transition-opacity group-focus-within:opacity-0 group-hover:opacity-0",
				look === "sheet" ? "bg-file-badge-sheet" : "bg-file-badge-other",
			)}
		>
			{extensionOf(file.name).toUpperCase() || "FILE"}
		</span>
	);
}

function UploadProgress({ name, fraction }: { name: string; fraction: number }) {
	const percent = Math.round(fraction * 100);
	return (
		<span
			role="progressbar"
			aria-label={`Uploading ${name}`}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={percent}
			className="absolute inset-x-0 bottom-0 z-[2] h-[3px] bg-border-strong"
		>
			<span className="block h-full bg-meter transition-[width]" style={{ width: `${percent}%` }} />
		</span>
	);
}

/** Whether `element` is taller than it shows, following its size and `contentKey`. */
function useOverflowsVertically(
	element: RefObject<HTMLElement | null>,
	contentKey: unknown,
): boolean {
	const [overflows, setOverflows] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `contentKey` stands for the content, which the observer does not see change.
	useLayoutEffect(() => {
		const target = element.current;
		if (!target) return;
		const measure = () => setOverflows(target.scrollHeight > target.clientHeight);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(target);
		return () => observer.disconnect();
	}, [element, contentKey]);
	return overflows;
}
