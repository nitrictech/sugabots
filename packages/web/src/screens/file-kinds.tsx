import type { WrittenFile, WrittenFileKind } from "@sugabots/contracts";
import { cn } from "cn";
import { ChevronDown, ChevronUp, FileText, type LucideIcon, PanelsTopLeft } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
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
	/** How Download saves it: as `type`, ending in `.extension`, holding `contentOf` its content. */
	file: { extension: string; type: string; contentOf: (content: string) => string };
	/** How wide its card among the messages may grow with its preview, as a Tailwind class. */
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

/** Saves the file as shown, as a file named after its title. */
export function downloadWrittenFile(file: Pick<WrittenFile, "kind" | "title" | "content">) {
	const { extension, type, contentOf } = FILE_KINDS[file.kind].file;
	const url = URL.createObjectURL(new Blob([contentOf(file.content)], { type }));
	const link = document.createElement("a");
	link.href = url;
	link.download = fileNameFor(file.title, extension);
	link.click();
	// Safari reads the file after `click` returns, so it is let go of later, not at once.
	setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_READ_MS);
}

/** Long enough for any browser to have read a downloaded file before it is let go of. */
const DOWNLOAD_READ_MS = 60_000;

/** `title` as a file name ending in `.extension`, without the characters file systems refuse. */
function fileNameFor(title: string, extension: string): string {
	const name = title.replace(/[\\/:*?"<>|]+/g, "-").trim();
	return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
}

export const FILE_KINDS: Record<WrittenFileKind, WrittenFileKindView> = {
	markdown: {
		label: FILE_KIND_LABELS.markdown,
		Icon: FileText,
		file: { ...FILE_KIND_DOWNLOADS.markdown, contentOf: (content) => content },
		// A preview, not the document: its start, at a reading width.
		cardWidth: "max-w-115",
		Inline: DocumentPreview,
		Full: ({ content }) => (
			<div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-list">
				<article className="mx-auto max-w-190 px-6 py-6 max-md:px-4">
					<MessageMarkdown text={content} mentionable={[]} writer="bot" />
				</article>
			</div>
		),
	},
	html: {
		label: FILE_KIND_LABELS.html,
		Icon: PanelsTopLeft,
		// Opened from disk, the page still can't reach the network, as in the app's frame.
		file: { ...FILE_KIND_DOWNLOADS.html, contentOf: withContentPolicy },
		// The page itself, running: room for a chart or a form.
		cardWidth: "max-w-160",
		Inline: LivePage,
		Full: ({ title, content, at }) => (
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border">
				<HtmlFrame html={content} title={title} at={at} className="min-h-0 flex-1" />
			</div>
		),
	},
};

/**
 * The start of a document, at one height whatever its length so every card
 * keeps its shape, faded out only where it is cut off. Clicked, it opens in
 * full. The card's own line opens it for the keyboard, so this is for a
 * pointer alone, and a screen reader reads the start as it is.
 */
function DocumentPreview({
	content,
	onOpen,
}: {
	title: string;
	content: string | undefined;
	onOpen: () => void;
}) {
	if (content === undefined) return <InlineLoading />;
	return <DocumentStart content={content} onOpen={onOpen} />;
}

function DocumentStart({ content, onOpen }: { content: string; onOpen: () => void }) {
	const frame = useRef<HTMLDivElement>(null);
	const words = useRef<HTMLDivElement>(null);
	const [cutOff, setCutOff] = useState(false);
	useLayoutEffect(() => {
		const shown = frame.current;
		const written = words.current;
		if (!shown || !written) return;
		const measure = () => setCutOff(written.offsetHeight > shown.clientHeight);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(written);
		return () => observer.disconnect();
	}, []);
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: a wider place for a pointer to open the file, which the card's line opens for the keyboard.
		<div
			ref={frame}
			onClick={onOpen}
			className={cn(
				"h-42 w-full cursor-zoom-in overflow-hidden text-xs",
				cutOff && "mask-b-from-60%",
			)}
		>
			<div ref={words} className="px-4 py-3">
				<MessageMarkdown text={content} mentionable={[]} writer="bot" />
			</div>
		</div>
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
							"absolute inset-x-0 bottom-0 bg-gradient-to-t from-card to-transparent pt-10",
					)}
				>
					<Button
						variant="secondary"
						size="sm"
						onClick={expanded ? collapse : () => setExpanded(true)}
						className="h-8 border border-border-strong bg-panel shadow-popover"
					>
						{expanded ? (
							<ChevronUp aria-hidden className="size-3.75" />
						) : (
							<ChevronDown aria-hidden className="size-3.75" />
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
		<div className="grid h-42 place-content-center text-muted-foreground text-xs">Loading…</div>
	);
}
