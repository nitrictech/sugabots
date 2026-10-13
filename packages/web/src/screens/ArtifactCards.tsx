import { artifactKindSchema, type ToolCallPart } from "@sugabots/contracts";
import { isApiFailure } from "@sugabots/sdk";
import { cn } from "cn";
import { Schema } from "effect";
import { ChevronDown, ChevronUp, Maximize2 } from "lucide-react";
import { useState } from "react";
import { ARTIFACT_WRITING_TOOLS, useArtifact } from "@/lib/artifacts.ts";
import { StageMark } from "@/shell/Stage.tsx";
import { Button } from "@/ui/button.tsx";
import { ARTIFACT_KINDS } from "./artifact-kinds.tsx";

const writtenArtifactSchema = Schema.Struct({
	status: Schema.Literal("written"),
	artifactId: Schema.String,
	kind: artifactKindSchema,
	title: Schema.String,
	version: Schema.Int,
});

export type WrittenArtifact = Omit<typeof writtenArtifactSchema.Type, "status">;

/**
 * The artifacts a reply's calls wrote, under its tool line, each a card at the
 * version the reply wrote that opens it large.
 */
export function ArtifactCards({
	calls,
	podId,
	botName,
	onOpen,
	className,
}: {
	calls: readonly ToolCallPart[];
	podId: string;
	/** The bot that wrote the reply, whom each card names as its maker. */
	botName: string;
	onOpen: (artifactId: string) => void;
	className?: string;
}) {
	const written = writtenBy(calls);
	if (written.length === 0) return null;
	return (
		<ul
			className={cn("m-0 flex w-full list-none flex-col items-start gap-2 p-0 pb-1.5", className)}
		>
			{written.map((artifact) => (
				<li key={artifact.artifactId} className="w-full">
					<ArtifactCard
						podId={podId}
						artifact={artifact}
						botName={botName}
						onOpen={() => onOpen(artifact.artifactId)}
					/>
				</li>
			))}
		</ul>
	);
}

function ArtifactCard({
	podId,
	artifact,
	botName,
	onOpen,
}: {
	podId: string;
	artifact: WrittenArtifact;
	botName: string;
	onOpen: () => void;
}) {
	const query = useArtifact(podId, artifact.artifactId, artifact.version);
	const content = !query.isError
		? query.data?.content
		: isApiFailure(query.error) && query.error._tag === "NotFound"
			? "deleted"
			: "failed";
	return (
		<ArtifactCardView
			podId={podId}
			artifact={artifact}
			botName={botName}
			content={content}
			onOpen={onOpen}
		/>
	);
}

/** A card showing only its header. */
const COLLAPSED_WIDTH = "max-w-[560px]";

/**
 * An artifact among the messages: a header that says which bot made it, so a
 * page is never taken for the app's own screens (a page can draw anything, a
 * sign-in form included). The header expands to show its content as its kind
 * shows it in place, and has a way to open it large.
 */
export function ArtifactCardView({
	podId,
	artifact,
	botName,
	content,
	onOpen,
}: {
	podId: string;
	artifact: WrittenArtifact;
	botName: string;
	/**
	 * Still loading while absent. Only the header is shown if it could not be
	 * loaded, and only its name, not to be opened, once it has been deleted.
	 */
	content: string | "failed" | "deleted" | undefined;
	onOpen: () => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const kind = ARTIFACT_KINDS[artifact.kind];
	const expandable = content !== "failed";
	const showsContent = expandable && expanded;
	if (content === "deleted") {
		return (
			<article
				aria-label={artifact.title}
				className={cn(
					"flex items-center gap-2.5 rounded-[12px] border border-border border-dashed px-3 py-2.5",
					COLLAPSED_WIDTH,
				)}
			>
				<span
					aria-hidden
					className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-chip text-subtle-foreground [&_svg]:size-4"
				>
					<kind.Icon strokeWidth={2} />
				</span>
				<span className="flex min-w-0 flex-1 flex-col gap-px">
					<span className="truncate font-medium text-muted-foreground text-sm line-through">
						{artifact.title}
					</span>
					<span className="truncate text-[12.5px] text-subtle-foreground">
						{kind.label} by {botName}, deleted
					</span>
				</span>
			</article>
		);
	}
	return (
		<article
			aria-label={artifact.title}
			className={cn(
				"overflow-hidden rounded-[12px] border border-border bg-panel",
				showsContent ? kind.cardWidth : COLLAPSED_WIDTH,
			)}
		>
			<div
				className={cn(
					"flex items-center gap-2.5 px-3 py-2.5",
					showsContent && "border-border border-b",
				)}
			>
				<StageMark>
					<kind.Icon strokeWidth={2} />
				</StageMark>
				<span className="flex min-w-0 flex-1 flex-col gap-px">
					<span className="truncate font-medium text-foreground text-sm">{artifact.title}</span>
					<span className="truncate text-[12.5px] text-muted-foreground">
						{kind.label} by {botName}
					</span>
				</span>
				{expandable && (
					<Button
						variant="ghost"
						size="sm"
						aria-expanded={expanded}
						aria-label={`${expanded ? "Hide" : "Preview"} ${artifact.title}`}
						onClick={() => setExpanded(!expanded)}
						className="border border-border-strong text-foreground"
					>
						{expanded ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
						{expanded ? "Hide" : "Preview"}
					</Button>
				)}
				<Button
					variant="secondary"
					size="sm"
					aria-label={`Open ${artifact.title}`}
					onClick={onOpen}
				>
					<Maximize2 aria-hidden />
					Open
				</Button>
			</div>
			{showsContent && (
				<kind.Inline
					title={artifact.title}
					content={content}
					at={{ podId, artifactId: artifact.artifactId, version: artifact.version }}
					onOpen={onOpen}
				/>
			)}
		</article>
	);
}

/** Each artifact the calls wrote, once, at the last version they wrote. */
function writtenBy(calls: readonly ToolCallPart[]): WrittenArtifact[] {
	const latest = new Map<string, WrittenArtifact>();
	for (const call of calls) {
		if (call.status !== "completed" || !ARTIFACT_WRITING_TOOLS.has(call.tool)) continue;
		const parsed = Schema.decodeUnknownResult(writtenArtifactSchema)(call.output);
		if (parsed._tag === "Failure") continue;
		const { status: _, ...artifact } = parsed.success;
		latest.set(artifact.artifactId, artifact);
	}
	return [...latest.values()];
}
