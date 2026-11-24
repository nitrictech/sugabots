import { linkMayGoTo } from "@sugabots/contracts/live-document";
import { getMarkRange } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { type Editor, EditorContent, useEditorState } from "@tiptap/react";
import { Check, ExternalLink, Pencil, Unlink } from "lucide-react";
import {
	type KeyboardEvent,
	type MouseEvent,
	type Ref,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { IS_MAC } from "@/lib/platform.ts";
import { CopyIconButton } from "@/ui/copy-icon-button.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { FloatingMenu, MENU_GAP_PX, MenuDivider } from "./floating-menu.tsx";
import { isInApp, LeavingDialog, LINK_WORDING } from "./leaving-the-app.tsx";

/**
 * LiveDocumentText draws the live document's text and handles its links:
 * how a click on one acts, and the menu for the link the caret is in. The
 * text goes on the page only through this, so its links can't be drawn
 * without this handling.
 *
 * A click on a link, with any button or key held, does what the editor does
 * with it: it places the caret, as on any words, or selects a linked image,
 * as any image. It opens nothing, and the browser never follows a link here
 * by itself. The link's menu is the way to open it, by its button or, while
 * the menu shows, with Alt and Enter. Bots write into a document, directly
 * and as suggestions, and nothing records who wrote a link, so a link's
 * words need not say where it goes. The menu shows the real address beside
 * the button that opens it, so opening it doesn't ask.
 *
 * Where the text can't be edited, no caret can go and there is no menu, so a
 * click on a link opens it instead, and asks first when it leaves the app, as
 * opening a bot's link in a message does (see `leaving-the-app.tsx`).
 *
 * A link opens in a new tab that gets no referrer and no hold on this one. A
 * link to an address that a text link may not go to opens nothing.
 */
export function LiveDocumentText({
	editor,
	ref,
	className,
	page,
	askBoxOpen,
}: {
	editor: Editor;
	/** The element holding the text. The cards and menus floating over the text are placed against it. */
	ref: Ref<HTMLElement>;
	className: string;
	/** The page that scrolls the text, out of which a link has no menu. */
	page: RefObject<HTMLElement | null>;
	/** Whether the box for asking the bot is open, which the link's menu makes way for. */
	askBoxOpen: boolean;
}) {
	// The address stays once the dialog closes, so the dialog still shows it while it fades out.
	const [asking, setAsking] = useState<{ href: string; open: boolean }>();
	/** Opens `href`, first asking when it leaves the app and its address hasn't been shown. */
	function open(href: string, { addressShown }: { addressShown: boolean }) {
		if (!linkMayGoTo(href)) return;
		if (addressShown || isInApp(href)) openInNewTab(href);
		else setAsking({ href, open: true });
	}
	function handleClickInText(event: MouseEvent<HTMLElement>) {
		const link = event.target instanceof Element ? event.target.closest("a") : null;
		if (!link || !event.currentTarget.contains(link)) return;
		event.preventDefault();
		if (editor.isEditable || !opensUneditableLink(event, link)) return;
		const href = addressOf(editor, link);
		if (href) open(href, { addressShown: false });
	}
	const editable = editor.isEditable;
	const menu = useLinkMenu(editor, page, { offered: editable && !askBoxOpen });
	/** Opens the link whose menu shows on Alt and Enter, before the editor takes the key for a new line. */
	function openLinkOnKeys(event: KeyboardEvent<HTMLElement>) {
		if (!menu.shown || !isOpenLinkKeys(event)) return;
		event.preventDefault();
		event.stopPropagation();
		open(menu.shown.link.href, { addressShown: true });
	}
	return (
		<>
			<article
				ref={ref}
				className={className}
				onClick={handleClickInText}
				onAuxClick={handleClickInText}
				onKeyDownCapture={openLinkOnKeys}
				onKeyDown={menu.onKeyDown}
			>
				<EditorContent editor={editor} />
			</article>
			{menu.shown && (
				<LinkMenu
					editor={editor}
					link={menu.shown.link}
					at={menu.shown.at}
					editing={menu.editing}
					onEditingChange={menu.setEditing}
					onOpen={(href) => open(href, { addressShown: true })}
				/>
			)}
			{asking && (
				<LeavingDialog
					href={asking.href}
					wording={LINK_WORDING}
					open={asking.open}
					onOpenChange={(opening) =>
						setAsking((current) => current && { ...current, open: opening })
					}
				/>
			)}
		</>
	);
}

/**
 * The address the document holds for the link drawn as `element`: the link
 * on its words, or a linked image's own. It is what a click opens where the
 * text can't be edited, rather than anything read from the page.
 */
function addressOf(editor: Editor, element: Element): string | undefined {
	const drawn = editor.state.doc.resolve(editor.view.posAtDOM(element, 0)).nodeAfter;
	if (drawn?.type.name === "image") {
		const link: unknown = drawn.attrs.link;
		return typeof link === "string" ? link : undefined;
	}
	const link = drawn?.marks.find((mark) => mark.type.name === "link");
	return link ? String(link.attrs.href) : undefined;
}

/**
 * `href` as a person is shown it: as the browser resolves it, so the host is
 * the one the browser goes to, written as the browser writes it, with a name
 * in another script as its `xn--` form. `head` runs to the end of the host
 * and is never cut short; `tail` is the rest. An address with no host, such
 * as an email's, is all tail.
 */
function shownAddress(href: string): { whole: string; head: string; tail: string } {
	const url = URL.parse(href, window.location.href);
	if (!url?.host) return { whole: url?.href ?? href, head: "", tail: url?.href ?? href };
	const credentials = url.username
		? `${url.username}${url.password ? `:${url.password}` : ""}@`
		: "";
	const head = `${url.protocol}//${credentials}${url.host}`;
	return { whole: url.href, head, tail: url.href.slice(head.length) };
}

/**
 * Whether a click on `link`, where the text can't be edited, opens it. A
 * click with the main or middle button does, unless Shift or Alt is held, or
 * a plain click ends a drag that selected the link's words.
 */
function opensUneditableLink(click: MouseEvent, link: Element): boolean {
	if (click.button > 1 || click.shiftKey || click.altKey) return false;
	if (click.button === 1 || click.ctrlKey || click.metaKey) return true;
	return !endsSelecting(click, link);
}

/**
 * Whether `click` ends a drag that selected words of `link`. A click from a
 * key or a screen reader comes with no count of presses, and never does.
 */
function endsSelecting(click: MouseEvent, link: Element): boolean {
	if (click.detail === 0) return false;
	const selection = window.getSelection();
	return (
		selection !== null &&
		selection.rangeCount > 0 &&
		selection.toString() !== "" &&
		selection.getRangeAt(0).intersectsNode(link)
	);
}

/** Whether the keys are the ones that open a link: Alt and Enter, Option and Enter on a Mac, and no others. */
const isOpenLinkKeys = (event: KeyboardEvent) =>
	event.key === "Enter" && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;

/** The keys that open a link, as the button that also opens it says them. */
const OPEN_LINK_KEYS = IS_MAC ? "Option + Enter" : "Alt + Enter";

/** Opens `href` in a new tab that gets no referrer and no hold on this one. */
function openInNewTab(href: string): void {
	window.open(href, "_blank", "noopener,noreferrer");
}

/** A link the caret is in: its address as the document holds it, where it is, and whether it is an image. */
interface ActiveLink {
	href: string;
	from: number;
	to: number;
	image: boolean;
}

/**
 * The link the caret is in with nothing selected, or the linked image that is
 * selected. A caret just after a link is in it, as typing there adds to it.
 */
function activeLinkOf(editor: Editor): ActiveLink | null {
	const { selection, schema } = editor.state;
	if (selection instanceof NodeSelection) {
		const { node, from, to } = selection;
		const link: unknown = node.type.name === "image" ? node.attrs.link : undefined;
		return typeof link === "string" ? { href: link, from, to, image: true } : null;
	}
	const linkType = schema.marks.link;
	const mark = selection.empty ? linkType?.isInSet(selection.$from.marks()) : undefined;
	const range = mark && getMarkRange(selection.$from, mark.type, mark.attrs);
	return mark && range ? { href: String(mark.attrs.href), ...range, image: false } : null;
}

const sameLink = (one: ActiveLink | null | undefined, other: ActiveLink | null | undefined) =>
	one?.href === other?.href &&
	one?.from === other?.from &&
	one?.to === other?.to &&
	one?.image === other?.image;

/**
 * Where the menu for the link the caret is in goes, while `offered`. It
 * shows while the text has the focus, and stays while its address is being
 * edited, which takes the focus. Escape puts it away until the caret leaves
 * the link. It goes when the link scrolls out of the page.
 */
function useLinkMenu(
	editor: Editor,
	page: RefObject<HTMLElement | null>,
	{ offered }: { offered: boolean },
) {
	const { link, focused } = useEditorState({
		editor,
		selector: ({ editor: current }) => ({
			link: activeLinkOf(current),
			focused: current.isFocused,
		}),
		equalityFn: (before, after) =>
			after !== null && before.focused === after.focused && sameLink(before.link, after.link),
	});
	const [editing, setEditing] = useState(false);
	const [putAway, setPutAway] = useState<ActiveLink>();
	useEffect(() => {
		if (link) return;
		setPutAway(undefined);
		setEditing(false);
	}, [link]);
	const showing =
		link !== null &&
		offered &&
		(focused || editing) &&
		!(putAway?.href === link.href && putAway.from === link.from);
	const [at, setAt] = useState<{ top: number; left: number }>();
	const place = useCallback(() => {
		if (!showing || !link) return setAt(undefined);
		const corner = topLeftOf(editor, link);
		const frame = page.current?.getBoundingClientRect();
		if (frame && (corner.top < frame.top || corner.top > frame.bottom)) return setAt(undefined);
		setAt({ top: corner.top - MENU_GAP_PX, left: corner.left });
	}, [editor, page, link, showing]);
	useLayoutEffect(place, [place]);
	// The menu sits in the window, so it is placed again whenever the text moves under it.
	useEffect(() => {
		window.addEventListener("scroll", place, true);
		window.addEventListener("resize", place);
		return () => {
			window.removeEventListener("scroll", place, true);
			window.removeEventListener("resize", place);
		};
	}, [place]);
	return {
		shown: link && at ? { link, at } : undefined,
		editing,
		setEditing,
		onKeyDown: (event: KeyboardEvent) => {
			if (event.key === "Escape" && showing && link) setPutAway(link);
		},
	};
}

/** The top left of the link in the window: of its first word, or of the image. */
function topLeftOf(editor: Editor, link: ActiveLink): { top: number; left: number } {
	const image = link.image ? editor.view.nodeDOM(link.from) : null;
	if (image instanceof Element) {
		const { top, left } = image.getBoundingClientRect();
		return { top, left };
	}
	const { top, left } = editor.view.coordsAtPos(link.from, 1);
	return { top, left };
}

/**
 * What can be done with the link the caret is in, floating above it: its
 * address, and opening, copying, editing and removing it. A long address is
 * cut short at its end, never before the end of its host, and shown whole on
 * hovering. Editing changes the menu into the box the address is typed in.
 */
function LinkMenu({
	editor,
	link,
	at,
	editing,
	onEditingChange,
	onOpen,
}: {
	editor: Editor;
	link: ActiveLink;
	at: { top: number; left: number };
	editing: boolean;
	onEditingChange: (editing: boolean) => void;
	onOpen: (href: string) => void;
}) {
	const address = shownAddress(link.href);
	return (
		<FloatingMenu at={at} label="Link">
			{editing ? (
				<LinkBox
					address={link.href}
					onApply={(address) => relink(editor, link, address)}
					onDone={() => {
						onEditingChange(false);
						editor.commands.focus();
					}}
				/>
			) : (
				<>
					<Tooltip side="top" label={<span className="break-all">{address.whole}</span>}>
						<span className="flex min-w-0 px-2 text-foreground text-xs">
							<span className="shrink-0 whitespace-nowrap">{address.head}</span>
							<span className="max-w-40 truncate">{address.tail}</span>
						</span>
					</Tooltip>
					<MenuDivider />
					<IconButton
						label={`Open link (${OPEN_LINK_KEYS})`}
						aria-keyshortcuts="Alt+Enter"
						side="top"
						disabled={!linkMayGoTo(link.href)}
						onClick={() => onOpen(link.href)}
					>
						<ExternalLink aria-hidden />
					</IconButton>
					<CopyIconButton label="Copy link" side="top" text={link.href} />
					<IconButton label="Edit link" side="top" onClick={() => onEditingChange(true)}>
						<Pencil aria-hidden />
					</IconButton>
					<IconButton
						label="Remove link"
						side="top"
						onClick={() => relink(editor, link, undefined)}
					>
						<Unlink aria-hidden />
					</IconButton>
				</>
			)}
		</FloatingMenu>
	);
}

/**
 * Points the link at `address`, or takes it off with none, keeping its words
 * or image, and the caret or selection where it was. These are edits like any
 * other, so in suggesting mode they are suggested.
 */
function relink(editor: Editor, link: ActiveLink, address: string | undefined) {
	if (link.image) {
		const attributes = address ? { link: address } : { link: null, linkTitle: null };
		editor.chain().focus().setNodeSelection(link.from).updateAttributes("image", attributes).run();
		return;
	}
	const { from, to } = editor.state.selection;
	const words = editor.chain().focus().setTextSelection({ from: link.from, to: link.to });
	(address ? words.setLink({ href: address }) : words.unsetLink())
		.setTextSelection({ from, to })
		.run();
}

/**
 * LinkBox is where a link's address is typed, in a floating menu's place.
 * Enter applies it, with no address taking the link off, and Escape leaves it
 * as it was. Either way `onDone` follows.
 */
export function LinkBox({
	address: linkedTo,
	onApply,
	onDone,
}: {
	/** The address the link has now, or nothing for text with no link yet. */
	address: string;
	/** Told the address to link to, or nothing when the box was emptied. */
	onApply: (address: string | undefined) => void;
	onDone: () => void;
}) {
	const [address, setAddress] = useState(linkedTo);
	// The person asked for this box, so typing goes here.
	const field = useRef<HTMLInputElement>(null);
	useEffect(() => field.current?.select(), []);
	return (
		<form
			className="flex items-center gap-1"
			onSubmit={(event) => {
				event.preventDefault();
				const typed = address.trim();
				onApply(typed === "" ? undefined : withScheme(typed));
				onDone();
			}}
		>
			<input
				ref={field}
				aria-label="Link address"
				placeholder="Paste a link"
				value={address}
				onChange={(event) => setAddress(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") onDone();
				}}
				className="h-6 w-64 rounded-md bg-transparent px-2 text-foreground text-xs outline-none placeholder:text-subtle-foreground"
			/>
			<IconButton label={address.trim() === "" ? "Remove link" : "Link"} type="submit">
				<Check aria-hidden />
			</IconButton>
		</form>
	);
}

/** An address as a link's target: one typed without a scheme, such as `example.com`, is a web address. */
const withScheme = (address: string) =>
	/^[a-z][a-z0-9+.-]*:/i.test(address) ? address : `https://${address}`;
