import { liveDocumentExtensions } from "@sugabots/contracts/live-document";
import { liveDocumentFromMarkdown } from "@sugabots/contracts/live-document-markdown";
import { getSchema } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";
import { type MouseEvent, useMemo } from "react";
import { artifactImageSource, type PageAt } from "@/lib/artifacts.ts";
import { opensUneditableLink, useLinkOpening } from "./live-document-text.tsx";
import { SlideDrawing } from "./slide-drawing.tsx";

/*
 * A deck read, not edited: drawn from its markdown, slide by slide, as its
 * editor draws it. This module holds the editor's libraries, so the views
 * that show a deck load it only once one is shown (see `artifact-kinds.tsx`).
 */

/** The slides `content`, a deck's markdown, holds, and how to draw them with the images version `at` keeps. */
function useDeck(content: string, { podId, artifactId }: PageAt) {
	const slides = useMemo(() => liveDocumentFromMarkdown("slides", content).children, [content]);
	const serializer = useMemo(
		() =>
			DOMSerializer.fromSchema(
				getSchema(
					liveDocumentExtensions({
						kind: "slides",
						undo: true,
						ownImages: { artifact: { podId, artifactId }, source: artifactImageSource },
					}),
				),
			),
		[podId, artifactId],
	);
	return { slides, serializer };
}

/** A deck's first slide, as wide as its card among the messages, opening the deck when clicked. */
export function DeckPreview({
	title,
	content,
	at,
	onOpen,
}: {
	title: string;
	content: string;
	at: PageAt;
	onOpen: () => void;
}) {
	const { slides, serializer } = useDeck(content, at);
	const [first] = slides;
	return (
		<button
			type="button"
			onClick={onOpen}
			aria-label={`Open ${title}`}
			className="focus-ring flex w-full cursor-zoom-in flex-col gap-2 px-3.5 py-3 text-left"
		>
			{first && (
				<SlideDrawing
					slide={first}
					serializer={serializer}
					hidden
					className="w-full overflow-hidden rounded-md ring-1 ring-border-strong"
				/>
			)}
			<span className="text-subtle-foreground text-xs">
				{slides.length === 1 ? "1 slide" : `${slides.length} slides`}
			</span>
		</button>
	);
}

/** A deck opened large to read, as at an earlier version: its slides one under another. */
export function DeckSlides({ content, at }: { content: string; at: PageAt }) {
	const { slides, serializer } = useDeck(content, at);
	const { open, leaving } = useLinkOpening();
	/** A link on a slide opens as one in text that can't be edited does, asking before it leaves the app. */
	function openLink(event: MouseEvent<HTMLElement>) {
		const link = event.target instanceof Element ? event.target.closest("a") : null;
		if (!link || !event.currentTarget.contains(link)) return;
		event.preventDefault();
		const href = link.getAttribute("href");
		if (href && opensUneditableLink(event, link)) open(href, { addressShown: false });
	}
	return (
		<div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-list">
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: a link's own Enter key clicks it, which this answers. */}
			<article
				onClick={openLink}
				onAuxClick={openLink}
				className="mx-auto max-w-240 px-8 py-6 max-md:px-4"
			>
				<ol className="m-0 flex list-none flex-col gap-6 p-0">
					{slides.map((slide, index) => (
						<li
							// A version's slides never change, so their places are their keys.
							// biome-ignore lint/suspicious/noArrayIndexKey: see above.
							key={index}
							aria-label={`Slide ${index + 1}`}
							className="overflow-hidden rounded-lg ring-1 ring-border-strong"
						>
							<SlideDrawing slide={slide} serializer={serializer} />
						</li>
					))}
				</ol>
			</article>
			{leaving}
		</div>
	);
}
