import type { WrittenFile, WrittenFileKind } from "@sugabots/contracts";
import { cn } from "cn";
import { ChevronDown, ChevronUp, FileText, type LucideIcon, PanelsTopLeft } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { FILE_KIND_DOWNLOADS, FILE_KIND_LABELS } from "@/lib/file-kind-catalog.ts";
import type { PageAt } from "@/lib/files.ts";
import { FIT_HEIGHT_PX } from "@/lib/page-frame.ts";
import { Button } from "@/ui/button.tsx";
import { HtmlFrame, withContentPolicy } from "./HtmlFrame.tsx";
import { MessageMarkdown } from "./MessageMarkdown.tsx";

/**
 * How each kind of file is shown and saved. A kind added to
 * `writtenFileKindSchema` is a type error here until it says how.
 */
interface WrittenFileKindView {
	/** What it is called beside its title, such as "Document". */
	label: string;
	Icon: LucideIcon;
	/** How Download saves it: as `type`, ending in `.extension`, holding `formatContent` its content. */
	file: { extension: string; type: string; formatContent: (content: string) => string };
	/** How wide its card among the messages may grow once expanded, as a Tailwind class. */
	cardWidth: string;
	/** Its content, version `at`, in a card among the messages; `undefined` while it loads. */
	Inline: (props: {
		title: string;
		content: string | undefined;
		at: PageAt;
		onOpen: () => void;
	}) => ReactNode;
	/** Its content, version `at`, opened large. */
	Full: (props: { title: string; content: string; at: PageAt }) => ReactNode;
}

export function OutsideRunPageNote({ source }: { source: NonNullable<WrittenFile["outsideRun"]> }) {
	return (
		<span className="block text-muted-foreground text-xs">
			{source === "github"
				? "Written by a run started by a GitHub event."
				: "Written by a run started by a webhook."}
		</span>
	);
}

export function LoadOutsideRunPage({
	source,
	children,
}: {
	source: NonNullable<WrittenFile["outsideRun"]>;
	children: ReactNode;
}) {
	const [loaded, setLoaded] = useState(false);
	return (
		<>
			<div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-panel p-3">
				<OutsideRunPageNote source={source} />
				{!loaded && (
					<Button variant="secondary" size="sm" onClick={() => setLoaded(true)}>
						Load page
					</Button>
				)}
			</div>
			{loaded && children}
		</>
	);
}

export const FILE_KINDS: Record<WrittenFileKind, WrittenFileKindView> = {
	markdown: {
		label: FILE_KIND_LABELS.markdown,
		Icon: FileText,
		file: { ...FILE_KIND_DOWNLOADS.markdown, formatContent: (content) => content },
		// A preview, not the document: wide enough for its tables.
		cardWidth: "max-w-2xl",
		Inline: DocumentPreview,
		Full: ({ content }) => (
			<div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-list">
				<article className="mx-auto max-w-3xl px-6 py-6 max-md:px-4">
					<MessageMarkdown text={content} mentionable={[]} writer="bot" />
				</article>
			</div>
		),
	},
	html: {
		label: FILE_KIND_LABELS.html,
		Icon: PanelsTopLeft,
		// Opened from disk, the page still can't reach the network, as in the app's frame.
		file: { ...FILE_KIND_DOWNLOADS.html, formatContent: withContentPolicy },
		// The page itself, running: as much room as the reply's text has.
		cardWidth: "max-w-none",
		Inline: LivePage,
		Full: ({ title, content, at }) => (
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border">
				<HtmlFrame html={content} title={title} at={at} className="min-h-0 flex-1" />
			</div>
		),
	},
};

/** The start of a document, faded out, opening it in full when clicked. */
function DocumentPreview({
	title,
	content,
	onOpen,
}: {
	title: string;
	content: string | undefined;
	onOpen: () => void;
}) {
	if (content === undefined) return <InlineLoading />;
	return (
		<button
			type="button"
			onClick={onOpen}
			aria-label={`Open ${title}`}
			className="focus-ring relative block max-h-44 w-full cursor-zoom-in overflow-hidden px-3.5 py-2 text-left text-xs mask-b-from-60%"
		>
			<MessageMarkdown text={content} mentionable={[]} writer="bot" />
		</button>
	);
}

/**
 * A page running in place, so a chart or a form works right in the chat. One
 * taller than the frame is clipped until the member asks to see it all.
 */
function LivePage({
	title,
	content,
	at,
}: {
	title: string;
	content: string | undefined;
	at: PageAt;
}) {
	const figure = useRef<HTMLDivElement>(null);
	const [pageHeight, setPageHeight] = useState(0);
	const [expanded, setExpanded] = useState(false);
	if (content === undefined) return <InlineLoading />;
	const tall = pageHeight > FIT_HEIGHT_PX.max;
	function collapse() {
		setExpanded(false);
		// Clipping a long page could leave the member far below it.
		figure.current?.scrollIntoView({ block: "nearest" });
	}
	return (
		<div ref={figure} className="relative">
			<HtmlFrame
				html={content}
				title={title}
				at={at}
				fitHeight
				maxHeight={expanded ? Number.POSITIVE_INFINITY : undefined}
				onPageHeight={setPageHeight}
			/>
			{tall && (
				<div
					className={cn(
						"flex justify-center pb-3",
						!expanded &&
							"absolute inset-x-0 bottom-0 bg-gradient-to-t from-panel to-transparent pt-10",
					)}
				>
					<Button
						variant="secondary"
						size="sm"
						onClick={expanded ? collapse : () => setExpanded(true)}
						className="h-8 border border-border-strong bg-panel shadow-popover"
					>
						{expanded ? (
							<ChevronUp aria-hidden className="size-4" />
						) : (
							<ChevronDown aria-hidden className="size-4" />
						)}
						{expanded ? "Show less" : "Show all"}
					</Button>
				</div>
			)}
		</div>
	);
}

function InlineLoading() {
	return (
		<div className="grid h-32 place-content-center text-muted-foreground text-xs">Loading…</div>
	);
}
