import type { ToolCallPart } from "@sugabots/contracts";
import { cn } from "cn";
import { ChevronDown, ChevronUp, FileText, Maximize2, PanelsTopLeft } from "lucide-react";
import { useRef, useState } from "react";
import { useArtifact } from "@/lib/artifacts.ts";
import { FIT_HEIGHT_PX, HtmlFrame } from "./HtmlFrame.tsx";

/** The tools whose result is an artifact written, as `artifactWritten` reads it. */
const WRITING_TOOLS = new Set(["artifact_create", "artifact_replace", "document_replace_section"]);

export interface WrittenArtifact {
	artifactId: string;
	kind: "document" | "html";
	title: string;
	version: number;
}

/**
 * The artifacts a reply's calls wrote, under its tool line: a page shown in
 * place, at the version the reply wrote, and a document as a card that opens
 * it.
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
	/** The bot that wrote the reply, whom a page shown in place is labelled as made by. */
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
				<li key={artifact.artifactId} className="w-full max-w-[640px]">
					{artifact.kind === "html" ? (
						<InlinePage podId={podId} artifact={artifact} botName={botName} onOpen={onOpen} />
					) : (
						<ArtifactCard artifact={artifact} onOpen={onOpen} />
					)}
				</li>
			))}
		</ul>
	);
}

function ArtifactCard({
	artifact,
	onOpen,
}: {
	artifact: WrittenArtifact;
	onOpen: (artifactId: string) => void;
}) {
	const Icon = artifact.kind === "html" ? PanelsTopLeft : FileText;
	return (
		<button
			type="button"
			onClick={() => onOpen(artifact.artifactId)}
			className="focus-ring flex max-w-[420px] items-center gap-2.5 rounded-[14px] border border-border bg-list px-3 py-2 text-left transition-colors hover:bg-hover"
		>
			<Icon aria-hidden size={18} className="shrink-0 text-soft-foreground" />
			<span className="flex min-w-0 flex-col">
				<span className="truncate font-semibold text-foreground text-sm">{artifact.title}</span>
				<span className="text-[12.5px] text-muted-foreground">
					{artifact.kind === "html" ? "Page" : "Document"} · version {artifact.version}
				</span>
			</span>
		</button>
	);
}

/** A page fetched at the version the reply wrote, shown in place. */
function InlinePage({
	podId,
	artifact,
	botName,
	onOpen,
}: {
	podId: string;
	artifact: WrittenArtifact;
	botName: string;
	onOpen: (artifactId: string) => void;
}) {
	const query = useArtifact(podId, artifact.artifactId, artifact.version);
	if (query.isError) return <ArtifactCard artifact={artifact} onOpen={onOpen} />;
	return (
		<InlinePageView
			artifact={artifact}
			botName={botName}
			html={query.data?.content}
			onOpen={onOpen}
		/>
	);
}

/**
 * A page shown in the conversation, captioned with the bot that made it so
 * what it draws is never taken for the app's own screens: a page can draw
 * anything, a sign-in form included. A page taller than the frame is clipped
 * until the person asks to see it all, and can be clipped again.
 */
export function InlinePageView({
	artifact,
	botName,
	html,
	onOpen,
}: {
	artifact: WrittenArtifact;
	botName: string;
	/** Still loading while absent. */
	html: string | undefined;
	onOpen: (artifactId: string) => void;
}) {
	const figure = useRef<HTMLElement>(null);
	const [pageHeight, setPageHeight] = useState(0);
	const [expanded, setExpanded] = useState(false);
	const tall = pageHeight > FIT_HEIGHT_PX.max;
	function collapse() {
		setExpanded(false);
		// Clipping a long page could leave the person far below it.
		figure.current?.scrollIntoView({ block: "nearest" });
	}
	return (
		<figure ref={figure} className="m-0 flex flex-col gap-1.5">
			<div className="relative overflow-hidden rounded-[14px] border border-border">
				{html === undefined ? (
					<div className="grid h-[120px] place-content-center text-muted-foreground text-sm">
						Loading page…
					</div>
				) : (
					<HtmlFrame
						html={html}
						title={artifact.title}
						fitHeight
						maxHeight={expanded ? Number.POSITIVE_INFINITY : undefined}
						onPageHeight={setPageHeight}
					/>
				)}
				{tall && !expanded && (
					<div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-background to-transparent pt-10 pb-3">
						<button
							type="button"
							onClick={() => setExpanded(true)}
							className="focus-ring flex h-8 items-center gap-1.5 rounded-full border border-border-strong bg-panel px-3.5 font-semibold text-[13px] text-foreground shadow-popover transition-colors hover:bg-hover"
						>
							<ChevronDown aria-hidden size={15} />
							Show all
						</button>
					</div>
				)}
			</div>
			<figcaption className="flex min-w-0 items-center gap-1.5 px-1 text-[12.5px] text-subtle-foreground">
				<PanelsTopLeft aria-hidden size={13} className="shrink-0" />
				<span className="min-w-0 truncate">
					<span className="font-medium text-muted-foreground">{artifact.title}</span> · page made by{" "}
					{botName}
				</span>
				{tall && expanded && (
					<button
						type="button"
						onClick={collapse}
						className="focus-ring ml-auto flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-link transition-colors hover:bg-hover"
					>
						<ChevronUp aria-hidden size={13} />
						Show less
					</button>
				)}
				<button
					type="button"
					onClick={() => onOpen(artifact.artifactId)}
					aria-label={`Open ${artifact.title}`}
					className={cn(
						"focus-ring flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-link transition-colors hover:bg-hover",
						!(tall && expanded) && "ml-auto",
					)}
				>
					Open
					<Maximize2 aria-hidden size={12} />
				</button>
			</figcaption>
		</figure>
	);
}

/** Each artifact the calls wrote, once, at the last version they wrote. */
function writtenBy(calls: readonly ToolCallPart[]): WrittenArtifact[] {
	const latest = new Map<string, WrittenArtifact>();
	for (const call of calls) {
		if (call.status !== "completed" || !WRITING_TOOLS.has(call.tool)) continue;
		const artifact = artifactWritten(call.output);
		if (artifact) latest.set(artifact.artifactId, artifact);
	}
	return [...latest.values()];
}

/** The artifact a writing tool's `{ status: "written", ... }` result names, if it is one. */
function artifactWritten(output: unknown): WrittenArtifact | undefined {
	if (typeof output !== "object" || output === null) return undefined;
	const result = output as Record<string, unknown>;
	if (
		result.status !== "written" ||
		typeof result.artifactId !== "string" ||
		(result.kind !== "document" && result.kind !== "html") ||
		typeof result.title !== "string" ||
		typeof result.version !== "number"
	) {
		return undefined;
	}
	return {
		artifactId: result.artifactId,
		kind: result.kind,
		title: result.title,
		version: result.version,
	};
}
