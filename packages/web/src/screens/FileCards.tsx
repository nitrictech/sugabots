import {
	filesWrittenBy,
	type MessagePart,
	type ToolCallPart,
	type WrittenFile,
	type WrittenFilePart,
} from "@sugabots/contracts";
import { isApiFailure } from "@sugabots/sdk";
import { cn } from "cn";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useFile } from "@/lib/files.ts";
import { Button } from "@/ui/button.tsx";
import { IconTile } from "@/ui/icon-tile.tsx";
import { FILE_KINDS, OutsideRunPageNote } from "./file-kinds.tsx";

/** A file as a message shows it: at the version written. */
export type FileAsWritten = Omit<WrittenFilePart, "type">;

/**
 * The files a message shows, each a card at the version written that
 * opens it large: those its reply's calls wrote, under its tool line, or, on an
 * automation's posted result, those its run wrote.
 */
export function FileCards({
	parts,
	botName,
	onOpen,
	className,
}: {
	parts: readonly MessagePart[];
	/** The bot that wrote the reply, whom each card names as its maker. */
	botName: string;
	onOpen: (fileId: string) => void;
	className?: string;
}) {
	const written = writtenIn(parts);
	if (written.length === 0) return null;
	return (
		<ul
			className={cn("m-0 flex w-full list-none flex-col items-start gap-2 p-0 pb-1.5", className)}
		>
			{written.map((file) => (
				<li key={file.fileId} className="w-full">
					<FileCard file={file} botName={botName} onOpen={() => onOpen(file.fileId)} />
				</li>
			))}
		</ul>
	);
}

function FileCard({
	file,
	botName,
	onOpen,
}: {
	file: FileAsWritten;
	botName: string;
	onOpen: () => void;
}) {
	const query = useFile(file.fileId, file.version);
	const content = !query.isError
		? query.data?.content
		: isApiFailure(query.error) && query.error._tag === "NotFound"
			? "deleted"
			: "failed";
	return (
		<FileCardView
			key={`${file.fileId}:${file.version}:${query.data?.outsideRun ?? ""}`}
			file={file}
			botName={botName}
			content={content}
			outsideRun={query.data?.outsideRun}
			onOpen={onOpen}
		/>
	);
}

/** How wide every card stands, whatever it shows. */
const CARD_WIDTH = "max-w-115";

/**
 * A file among the messages: a preview of its content on top, as its kind
 * shows it in place, over a line that says which bot made it, so a page is
 * never taken for the app's own screens (a page can draw anything, a
 * sign-in form included), and opens it large. A page from outside the run
 * loads only once asked.
 */
export function FileCardView({
	file,
	botName,
	content,
	outsideRun,
	onOpen,
}: {
	file: FileAsWritten;
	botName: string;
	/**
	 * Still loading while absent. Only its line is shown if it could not be
	 * loaded, and only its name, not to be opened, once it has been deleted.
	 */
	content: string | "failed" | "deleted" | undefined;
	outsideRun?: WrittenFile["outsideRun"];
	onOpen: () => void;
}) {
	const [pageLoaded, setPageLoaded] = useState(false);
	const kind = FILE_KINDS[file.kind];
	const outsidePage = file.kind === "html" ? outsideRun : undefined;
	if (content === "deleted") {
		return (
			<article
				aria-label={file.title}
				className={cn(
					"flex items-center gap-3 rounded-bubble border border-border border-dashed px-3.5 py-3",
					CARD_WIDTH,
				)}
			>
				<IconTile size="md" tone="faded">
					<kind.Icon strokeWidth={2} />
				</IconTile>
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="truncate font-medium text-muted-foreground text-sm leading-snug line-through">
						{file.title}
					</span>
					<span className="truncate text-subtle-foreground text-xs leading-snug">
						{kind.label} by {botName}, deleted
					</span>
				</span>
			</article>
		);
	}
	const previewed = content !== "failed";
	return (
		<article
			aria-label={file.title}
			className={cn(
				"flex min-w-0 flex-col rounded-bubble border border-border bg-card",
				CARD_WIDTH,
			)}
		>
			{previewed && (
				// Clipped here rather than by the card, so the line's focus ring shows whole.
				<div className="min-w-0 overflow-hidden rounded-t-bubble border-border border-b">
					{outsidePage && !pageLoaded ? (
						<div className="flex flex-col items-start gap-2.5 px-4 py-3.5">
							<OutsideRunPageNote source={outsidePage} />
							<Button
								variant="secondary"
								size="sm"
								aria-label={`Load page ${file.title}`}
								onClick={() => setPageLoaded(true)}
							>
								Load page
							</Button>
						</div>
					) : (
						<kind.Inline
							title={file.title}
							content={content}
							at={{ fileId: file.fileId, version: file.version }}
							onOpen={onOpen}
						/>
					)}
				</div>
			)}
			<button
				type="button"
				onClick={onOpen}
				aria-label={`Open ${file.title}`}
				className={cn(
					"group/line focus-ring flex min-w-0 items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-hover",
					previewed ? "rounded-b-bubble" : "rounded-bubble",
				)}
			>
				<IconTile size="md" tone="tile">
					<kind.Icon strokeWidth={2} />
				</IconTile>
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="truncate font-medium text-sm leading-snug">{file.title}</span>
					<span className="truncate text-muted-foreground text-xs leading-snug">
						{kind.label} by {botName}
					</span>
				</span>
				<ChevronRight
					aria-hidden
					className="size-4 shrink-0 text-subtle-foreground transition group-hover/line:translate-x-0.5 group-hover/line:text-foreground motion-reduce:transition-none"
				/>
			</button>
		</article>
	);
}

/**
 * Each file the parts show, once: those a posted result carries, and
 * those a reply's calls wrote.
 */
function writtenIn(parts: readonly MessagePart[]): WrittenFilePart[] {
	const carried = parts.filter((part): part is WrittenFilePart => part.type === "written_file");
	const calls = parts.filter((part): part is ToolCallPart => part.type === "tool_call");
	const byId = new Map([...carried, ...filesWrittenBy(calls)].map((file) => [file.fileId, file]));
	return [...byId.values()];
}
