import { linkMayGoTo } from "@sugabots/contracts/live-document";
import { type Editor, EditorContent } from "@tiptap/react";
import { type MouseEvent, type Ref, useState } from "react";
import { isInApp, LeavingDialog, LINK_WORDING } from "./leaving-the-app.tsx";

/**
 * LiveDocumentText draws the live document's text, and asks before a link in
 * it leaves the app. Bots write into a document, directly and as suggestions,
 * and nothing records who wrote a link. So each link here, words or an image,
 * asks as a bot's link in a message does (see `leaving-the-app.tsx`). The
 * text goes on the page only through this, so its links can't be drawn
 * without the asking.
 *
 * The browser never follows a link here by itself, whether the document can
 * be edited or not. Instead, a click on a link does this:
 * - A plain click on a link off the app asks first, showing the whole address.
 * - A plain click on a link into the app opens it.
 * - A Ctrl or Cmd click, or a middle click, opens it, as the reader chose where it opens.
 * - A Shift or Alt click is left to the editor, which extends the selection on a Shift click.
 * - A click that ends a drag selecting the link's words is left to the editor too.
 *
 * A link opens in a new tab that gets no referrer and no hold on this one. A
 * link to an address that a text link may not go to is drawn with no address,
 * and a click on it does nothing.
 */
export function LiveDocumentText({
	editor,
	ref,
	className,
}: {
	editor: Editor;
	/** The element holding the text. The cards and menus floating over the text are placed against it. */
	ref: Ref<HTMLElement>;
	className: string;
}) {
	// The address stays once the dialog closes, so the dialog still shows it while it fades out.
	const [asking, setAsking] = useState<{ href: string; open: boolean }>();
	function handleClickInText(event: MouseEvent<HTMLElement>) {
		// Any other button opens the reader's own menu.
		if (event.button > 1) return;
		const link = event.target instanceof Element ? event.target.closest("a") : null;
		if (!link || !event.currentTarget.contains(link)) return;
		event.preventDefault();
		const href = link.getAttribute("href");
		if (!href || !linkMayGoTo(href) || isEditorsClick(event, link)) return;
		const readerChoseWhere = event.button === 1 || event.ctrlKey || event.metaKey;
		if (readerChoseWhere || isInApp(href)) openInNewTab(href);
		else setAsking({ href, open: true });
	}
	return (
		<>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: the clicks handled are on the links inside, which the keyboard reaches and activates as clicks. */}
			<article
				ref={ref}
				className={className}
				onClick={handleClickInText}
				onAuxClick={handleClickInText}
			>
				<EditorContent editor={editor} />
			</article>
			{asking && (
				<LeavingDialog
					href={asking.href}
					wording={LINK_WORDING}
					open={asking.open}
					onOpenChange={(open) => setAsking((current) => current && { ...current, open })}
				/>
			)}
		</>
	);
}

/**
 * Whether a click on `link` is the editor's to handle rather than a link to
 * follow: a Shift or Alt click, which edits, or one ending a drag that
 * selected words of the link. A click from a key or a screen reader comes
 * with no count of presses, and never ends a drag.
 */
function isEditorsClick(click: MouseEvent, link: Element): boolean {
	if (click.shiftKey || click.altKey) return true;
	if (click.detail === 0) return false;
	const selection = window.getSelection();
	// An image selected by the click has no words, so a click on a linked image is never a drag.
	return (
		selection !== null &&
		selection.rangeCount > 0 &&
		selection.toString() !== "" &&
		selection.getRangeAt(0).intersectsNode(link)
	);
}

/** Opens `href` in a new tab that gets no referrer and no hold on this one. */
function openInNewTab(href: string): void {
	window.open(href, "_blank", "noopener,noreferrer");
}
