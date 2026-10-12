import type { ArtifactKind } from "@sugabots/contracts";
import { cn } from "cn";
import { ChevronDown, ChevronUp, FileText, type LucideIcon, PanelsTopLeft } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import type { PageAt } from "@/lib/artifacts.ts";
import { FIT_HEIGHT_PX, HtmlFrame, withContentPolicy } from "./HtmlFrame.tsx";
import { MessageMarkdown } from "./MessageMarkdown.tsx";

/**
 * How each kind of artifact is shown and saved. A kind added to
 * `artifactKindSchema` is a type error here until it says how.
 */
export interface ArtifactKindView {
	/** What it is called beside its title, such as "Document". */
	label: string;
	Icon: LucideIcon;
	/** How Download saves it: as `type`, ending in `.extension`, holding `contentOf` its content. */
	file: { extension: string; type: string; contentOf: (content: string) => string };
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

export const ARTIFACT_KINDS: Record<ArtifactKind, ArtifactKindView> = {
	document: {
		label: "Document",
		Icon: FileText,
		file: { extension: "md", type: "text/markdown", contentOf: (content) => content },
		// A preview, not the document: wide enough for its tables.
		cardWidth: "max-w-[640px]",
		Inline: DocumentPreview,
		Full: ({ content }) => (
			<div className="min-h-0 flex-1 overflow-y-auto rounded-[12px] border border-border bg-list">
				<article className="mx-auto max-w-[760px] px-6 py-6 max-md:px-4">
					<MessageMarkdown text={content} mentionable={[]} />
				</article>
			</div>
		),
	},
	html: {
		label: "Page",
		Icon: PanelsTopLeft,
		// Opened from disk, the page still can't reach the network, as in the app's frame.
		file: { extension: "html", type: "text/html", contentOf: withContentPolicy },
		// The page itself, running: as much room as the reply's text has.
		cardWidth: "max-w-none",
		Inline: LivePage,
		Full: ({ title, content, at }) => (
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-border">
				<HtmlFrame html={content} title={title} at={at} className="min-h-0 flex-1" />
			</div>
		),
	},
};

const DOCUMENT_PREVIEW_HEIGHT_PX = 168;

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
			style={{ maxHeight: DOCUMENT_PREVIEW_HEIGHT_PX }}
			className="focus-ring relative block w-full cursor-zoom-in overflow-hidden px-3.5 py-2 text-left text-sm [mask-image:linear-gradient(to_bottom,black_60%,transparent)]"
		>
			<MessageMarkdown text={content} mentionable={[]} />
		</button>
	);
}

/**
 * A page running in place, so a chart or a form works right in the chat. One
 * taller than the frame is clipped until the person asks to see it all.
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
		// Clipping a long page could leave the person far below it.
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
					<button
						type="button"
						onClick={expanded ? collapse : () => setExpanded(true)}
						className="focus-ring flex h-8 items-center gap-1.5 rounded-full border border-border-strong bg-panel px-3.5 font-semibold text-[13px] text-foreground shadow-popover transition-colors hover:bg-hover"
					>
						{expanded ? <ChevronUp aria-hidden size={15} /> : <ChevronDown aria-hidden size={15} />}
						{expanded ? "Show less" : "Show all"}
					</button>
				</div>
			)}
		</div>
	);
}

function InlineLoading() {
	return (
		<div className="grid h-[120px] place-content-center text-muted-foreground text-sm">
			Loading…
		</div>
	);
}
