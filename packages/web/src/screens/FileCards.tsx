import {
	filesWrittenBy,
	type MessagePart,
	type ToolCallPart,
	type WrittenFilePart,
} from "@sugabots/contracts";
import { isApiFailure } from "@sugabots/sdk";
import { cn } from "cn";
import { ChevronDown, ChevronUp, Maximize2 } from "lucide-react";
import { useState } from "react";
import { useFile } from "@/lib/files.ts";
import { StageMark } from "@/shell/Stage.tsx";
import { Button } from "@/ui/button.tsx";
import { FILE_KINDS } from "./file-kinds.tsx";

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
	return <FileCardView file={file} botName={botName} content={content} onOpen={onOpen} />;
}

/** A card showing only its header. */
const COLLAPSED_WIDTH = "max-w-140";

/**
 * A file among the messages: a header that says which bot made it, so a
 * page is never taken for the app's own screens (a page can draw anything, a
 * sign-in form included). The header expands to show its content as its kind
 * shows it in place, and has a way to open it large.
 */
export function FileCardView({
	file,
	botName,
	content,
	onOpen,
}: {
	file: FileAsWritten;
	botName: string;
	/**
	 * Still loading while absent. Only the header is shown if it could not be
	 * loaded, and only its name, not to be opened, once it has been deleted.
	 */
	content: string | "failed" | "deleted" | undefined;
	onOpen: () => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const kind = FILE_KINDS[file.kind];
	const expandable = content !== "failed";
	const showsContent = expandable && expanded;
	if (content === "deleted") {
		return (
			<article
				aria-label={file.title}
				className={cn(
					"flex items-center gap-2.5 rounded-xl border border-border border-dashed px-3 py-2.5",
					COLLAPSED_WIDTH,
				)}
			>
				<span
					aria-hidden
					className="grid size-8 shrink-0 place-items-center rounded-md bg-chip text-subtle-foreground [&_svg]:size-4"
				>
					<kind.Icon strokeWidth={2} />
				</span>
				<span className="flex min-w-0 flex-1 flex-col gap-px">
					<span className="truncate font-medium text-muted-foreground text-xs line-through">
						{file.title}
					</span>
					<span className="truncate text-xs text-subtle-foreground">
						{kind.label} by {botName}, deleted
					</span>
				</span>
			</article>
		);
	}
	return (
		<article
			aria-label={file.title}
			className={cn(
				"overflow-hidden rounded-xl border border-border bg-panel",
				showsContent ? kind.cardWidth : COLLAPSED_WIDTH,
			)}
		>
			<div
				className={cn(
					"flex flex-wrap items-center gap-2.5 px-3 py-2.5",
					showsContent && "border-border border-b",
				)}
			>
				<StageMark>
					<kind.Icon strokeWidth={2} />
				</StageMark>
				<span className="flex min-w-card-name flex-1 flex-col gap-px">
					<span className="truncate font-medium text-foreground text-xs">{file.title}</span>
					<span className="truncate text-xs text-muted-foreground">
						{kind.label} by {botName}
					</span>
				</span>
				<div className="ml-auto flex gap-2.5">
					{expandable && (
						<Button
							variant="ghost"
							size="sm"
							aria-expanded={expanded}
							aria-label={`${expanded ? "Hide" : "Preview"} ${file.title}`}
							onClick={() => setExpanded(!expanded)}
							className="border border-border-strong text-foreground"
						>
							{expanded ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
							{expanded ? "Hide" : "Preview"}
						</Button>
					)}
					<Button variant="secondary" size="sm" aria-label={`Open ${file.title}`} onClick={onOpen}>
						<Maximize2 aria-hidden />
						Open
					</Button>
				</div>
			</div>
			{showsContent && (
				<kind.Inline
					title={file.title}
					content={content}
					at={{ fileId: file.fileId, version: file.version }}
					onOpen={onOpen}
				/>
			)}
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
