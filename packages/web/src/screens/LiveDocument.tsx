import {
	disableSuggestChanges,
	enableSuggestChanges,
	isSuggestChangesEnabled,
} from "@handlewithcare/prosemirror-suggest-changes";
import { HocuspocusProvider } from "@hocuspocus/provider";
import {
	agentColorSchema,
	agentFaceSchema,
	agentShapeSchema,
	MAX_ARTIFACT_IMAGE_BYTES,
} from "@sugabots/contracts";
import {
	type EditRequest,
	LIVE_DOCUMENT_CONTENT,
	LIVE_DOCUMENT_EDIT_REQUESTS,
	LIVE_DOCUMENT_SCHEMA,
	liveDocumentExtensions,
} from "@sugabots/contracts/live-document";
import { Extension } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import { Dropcursor } from "@tiptap/extensions/drop-cursor";
import { Placeholder } from "@tiptap/extensions/placeholder";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { type Editor, useEditor, useEditorState } from "@tiptap/react";
import { cn } from "cn";
import { Effect, Schema } from "effect";
import {
	ArrowUp,
	Bold,
	Check,
	ChevronDown,
	Italic,
	Link2,
	type LucideIcon,
	Pencil,
	PenLine,
	Sparkles,
	Strikethrough,
	Underline,
	X,
} from "lucide-react";
import {
	type CSSProperties,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { v4 as uuidv4 } from "uuid";
import { Doc } from "yjs";
import { client } from "@/api.ts";
import { apiBaseUrl } from "@/lib/api-url.ts";
import { artifactImageSource, uploadArtifactImage } from "@/lib/artifacts.ts";
import { failureMessage } from "@/lib/failure.ts";
import { Suggesting, suggestingAs } from "@/lib/suggesting.ts";
import { type PendingSuggestion, pendingSuggestions, settling } from "@/lib/suggestions.ts";
import { ImageNotKept, importWordFile, type KeepImage } from "@/lib/word-import.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { Button } from "@/ui/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import {
	BLOCK_KINDS,
	BlockHandle,
	BlockIcon,
	blockKindAt,
	type Range,
	SlashMenu,
	type TextKeys,
	TypedHint,
	turnInto,
} from "./LiveDocumentBlocks.tsx";
import { Outline } from "./LiveDocumentOutline.tsx";
import { LiveDocumentText } from "./live-document-text.tsx";

/** Who the person is to the others in the document. */
export interface Editing {
	name: string;
	email: string;
	image?: string | null;
}

/**
 * A `document` artifact being edited with everyone else who has it open,
 * people and bots: what anyone types appears for all of them, with a caret
 * for each. It saves as it goes, so there is nothing to save.
 */
export function LiveDocument({
	workspaceId,
	podId,
	artifactId,
	title,
	as,
	bot,
	onWordImport,
	presenceSlot,
	statusSlot,
}: {
	workspaceId: string;
	podId: string;
	artifactId: string;
	title: string;
	as: Editing;
	/** The bot people here can ask for edits: the one that made the document, unless it has been removed. */
	bot: AskedBot | undefined;
	/** Given how to replace the document with a Word file's content once the editor is up, and `undefined` when it goes. */
	onWordImport: (importWord: WordImport | undefined) => void;
	/** Where the faces of the others in the document are drawn: a place outside the page, such as its title bar. */
	presenceSlot: HTMLElement | null;
	/** Where it says whether everything typed is saved: a place outside the page, such as after its title. */
	statusSlot: HTMLElement | null;
}) {
	const provider = useLiveDocument(podId, artifactId);
	const keepImage = useCallback<KeepImage>(
		(image) => uploadArtifactImage({ podId, artifactId }, image),
		[podId, artifactId],
	);
	return (
		<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-list">
			{provider && (
				<LiveEditor
					key={artifactId}
					provider={provider}
					artifact={{ podId, artifactId }}
					title={title}
					as={as}
					bot={bot}
					onAsk={(bot, asked) => askForEdit({ workspaceId, podId, artifactId, title, bot, asked })}
					keepImage={keepImage}
					onWordImport={onWordImport}
					presenceSlot={presenceSlot}
					statusSlot={statusSlot}
				/>
			)}
		</div>
	);
}

/** The connection to the artifact's live document, for as long as it is on screen. */
function useLiveDocument(podId: string, artifactId: string) {
	const [provider, setProvider] = useState<HocuspocusProvider>();
	useEffect(() => {
		const opened = new HocuspocusProvider({
			url: liveDocumentUrl(podId, artifactId),
			name: artifactId,
			document: new Doc(),
		});
		setProvider(opened);
		return () => {
			opened.destroy();
			setProvider(undefined);
		};
	}, [podId, artifactId]);
	return provider;
}

function LiveEditor({
	provider,
	artifact,
	title,
	as,
	bot,
	onAsk,
	keepImage,
	onWordImport,
	presenceSlot,
	statusSlot,
}: {
	provider: HocuspocusProvider;
	/** The document's artifact, whose kept images are the only ones it loads. */
	artifact: { podId: string; artifactId: string };
	title: string;
	as: Editing;
	bot: AskedBot | undefined;
	/** Asks `bot` for the edit, answering the id of the thread the bot will work in. */
	onAsk: (bot: AskedBot, asked: Asked) => Promise<string>;
	/** Keeps an image from a Word file for the document. */
	keepImage: KeepImage;
	onWordImport: (importWord: WordImport | undefined) => void;
	presenceSlot: HTMLElement | null;
	statusSlot: HTMLElement | null;
}) {
	const slashKeys = useRef<TextKeys>(undefined);
	const editor = useEditor({
		extensions: [
			...liveDocumentExtensions({
				undo: false,
				ownImages: { artifact, source: artifactImageSource },
			}),
			EditTarget,
			EmptyHints,
			DropLine,
			Suggesting,
			Collaboration.configure({ document: provider.document, field: LIVE_DOCUMENT_CONTENT }),
			CollaborationCaret.configure({
				provider,
				user: { ...as, color: caretColor(as.name) } satisfies Participant,
			}),
		],
		editorProps: {
			// Its own padding, not the page's, so the pointer is over the editor while in the
			// margin beside a block, where the block's handle shows.
			attributes: { class: "live-document px-16 max-md:px-4", "aria-label": title },
			handleKeyDown: (_view, event) => slashKeys.current?.(event) ?? false,
		},
		// Without this the sync layer deletes, for everyone, whatever this editor's schema cannot hold.
		// With it, such content stops this editor instead: it leaves the document and says to reload.
		enableContentCheck: true,
		onContentError: ({ editor: unreadable, disableCollaboration }) => {
			disableCollaboration();
			unreadable.setEditable(false);
			setOutOfDate(true);
		},
	});
	const [outOfDate, setOutOfDate] = useState(false);
	const others = useOthers(provider);
	const requests = useEditRequests(provider);
	const saved = useSaved(provider);
	const page = useRef<HTMLDivElement>(null);
	const text = useRef<HTMLElement>(null);
	const [asking, setAsking] = useState<Asking>();
	const [awaited, setAwaited] = useState<Awaited[]>([]);
	const suggestions = useSuggestions(editor, page, text);
	const settle = (suggestionId: string, how: "accept" | "reject") =>
		editor && settling(suggestionId, how)(editor.state, editor.view.dispatch);
	const [mode, setMode] = useEditingMode(editor, as);
	// The mark on the text asked about goes once nothing is being asked or waited for.
	const stillWaiting = awaited.some(({ threadId }) =>
		requests.waiting.some((request) => request.threadId === threadId),
	);
	useEffect(() => {
		if (!editor || asking || stillWaiting) return;
		editor.view.dispatch(editor.state.tr.setMeta(editTarget, null));
	}, [editor, asking, stillWaiting]);
	// What the last Word file imported here left out, or why it wasn't imported.
	const [importNotice, setImportNotice] = useState<string>();
	useEffect(() => {
		if (!editor) return;
		onWordImport(async (file) => {
			setImportNotice(undefined);
			try {
				const { imagesLeftOut } = await importWordFile(editor, file, keepImage);
				if (imagesLeftOut > 0) setImportNotice(imagesLeftOutInWords(imagesLeftOut));
			} catch (failure) {
				setImportNotice(importFailureInWords(failure));
			}
		});
		return () => onWordImport(undefined);
	}, [editor, onWordImport, keepImage]);
	const [menuHeld, setMenuHeld] = useState(false);
	// Where the line starts that the + beside a block opened the menu of blocks on.
	const [blocksOfferedAt, setBlocksOfferedAt] = useState<number>();
	const endBlocksOffer = useCallback(() => setBlocksOfferedAt(undefined), []);
	const offer = useSelectionMenu(editor, page, {
		offered: asking === undefined,
		held: menuHeld,
	});
	if (!editor) return null;
	/** Opens the box under the selected text, which stays marked while the box is open. */
	function startAsking() {
		if (!editor || !offer) return;
		editor.view.dispatch(editor.state.tr.setMeta(editTarget, offer.selected));
		// Under the start of the selection, moved left where it would run off the page.
		const roomAcross = (page.current?.clientWidth ?? 0) - ASK_BOX_WIDTH_PX - ASK_BOX_MARGIN_PX;
		setAsking({
			...askedAbout(editor.state.doc, offer.selected),
			top: offer.below,
			left: Math.max(ASK_BOX_MARGIN_PX, Math.min(offer.left, roomAcross)),
		});
	}
	/** Opens the box under the empty line the caret is on, for something to be written there. */
	function startAskingToWrite() {
		const element = page.current;
		if (!editor || !element) return;
		const { from } = editor.state.selection;
		const frame = element.getBoundingClientRect();
		const line = editor.view.coordsAtPos(from);
		const roomAcross = element.clientWidth - ASK_BOX_WIDTH_PX - ASK_BOX_MARGIN_PX;
		setAsking({
			...askedAbout(editor.state.doc, { from, to: from }),
			top: line.bottom - frame.top + element.scrollTop + EDIT_OFFER_GAP_PX,
			left: Math.max(ASK_BOX_MARGIN_PX, Math.min(line.left - frame.left, roomAcross)),
		});
	}
	function stopAsking() {
		editor?.view.dispatch(editor.state.tr.setMeta(editTarget, null));
		setAsking(undefined);
	}
	async function ask(bot: AskedBot, instruction: string) {
		if (!asking) return;
		const threadId = await onAsk(bot, { ...asking, instruction });
		requests.add(threadId, { instruction, agent: bot.name, answered: false });
		// The text stays marked, with a note under it, until the bot's suggestion takes its place.
		setAwaited((awaited) => [...awaited, { threadId, top: asking.top, left: asking.left }]);
		setAsking(undefined);
	}
	const waiting = awaited.flatMap((at) => {
		const request = requests.waiting.find(({ threadId }) => threadId === at.threadId);
		return request ? [{ ...at, agent: request.agent }] : [];
	});
	return (
		<>
			{presenceSlot &&
				createPortal(
					<>
						<Others others={others} />
						<EditingModePicker mode={mode} onChange={setMode} />
					</>,
					presenceSlot,
				)}
			{statusSlot && createPortal(saved ? "Saved" : "Saving", statusSlot)}
			{outOfDate && (
				<Notice>
					<span className="min-w-0 flex-1">
						This document has content this tab can't show, so editing here is off. Reload to get the
						latest editor. Nothing in the document was changed.
					</span>
					<Button size="sm" onClick={() => window.location.reload()}>
						Reload
					</Button>
				</Notice>
			)}
			{importNotice && (
				<Notice>
					<span className="min-w-0 flex-1">{importNotice}</span>
					<IconButton label="Dismiss" onClick={() => setImportNotice(undefined)}>
						<X aria-hidden />
					</IconButton>
				</Notice>
			)}
			<div ref={page} className="@container relative min-h-0 flex-1 overflow-y-auto">
				<Outline editor={editor} />
				<LiveDocumentText
					editor={editor}
					ref={text}
					className="mx-auto max-w-204 pt-14 pb-30 max-md:pt-6"
				/>
				{!outOfDate && <BlockHandle editor={editor} onOffer={setBlocksOfferedAt} />}
				{!asking && !outOfDate && (
					<SlashMenu
						editor={editor}
						page={page}
						keys={slashKeys}
						offeredAt={blocksOfferedAt}
						onOfferEnd={endBlocksOffer}
						writeWith={bot ? { onStart: startAskingToWrite } : undefined}
					/>
				)}
				{offer && (
					<SelectionMenu
						editor={editor}
						at={offer.menu}
						editWith={bot ? { name: bot.name, onStart: startAsking } : undefined}
						onHold={setMenuHeld}
					/>
				)}
				{asking && bot && (
					<AskBox
						at={asking}
						bot={bot}
						writing={asking.selected === ""}
						onAsk={(instruction) => ask(bot, instruction)}
						onCancel={() => {
							stopAsking();
							editor.commands.focus();
						}}
						onClickAway={stopAsking}
					/>
				)}
				{waiting.map((request) => (
					<UnderText key={request.threadId} at={request} label={`${request.agent} is working`}>
						<Sparkles aria-hidden size={13} className="ml-1.5 animate-pulse text-suggestion" />
						<span className="px-1 text-soft-foreground text-xs">{request.agent} is working</span>
						<IconButton label="Stop waiting" onClick={() => requests.dismiss(request.threadId)}>
							<X aria-hidden />
						</IconButton>
					</UnderText>
				))}
				{suggestions.map(({ suggestion, at }) => (
					<SuggestionCard
						key={suggestion.id}
						suggestion={suggestion}
						at={at}
						onAccept={() => settle(suggestion.id, "accept")}
						onUndo={() => settle(suggestion.id, "reject")}
					/>
				))}
			</div>
		</>
	);
}

/** Something about a stretch of the text, floating just under it: what a bot is doing there, or what to do with its suggestion. */
function UnderText({
	at,
	label,
	children,
}: {
	at: { top: number; left: number };
	label: string;
	children: ReactNode;
}) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: a fieldset draws a border and legend this has no use for.
		<div
			role="group"
			aria-label={label}
			style={at}
			className="absolute z-10 flex items-center gap-0.5 rounded-full border border-border-strong bg-panel p-1 shadow-popover"
		>
			{children}
		</div>
	);
}

/** As wide as the document's text and padded as the editor pads it, with room at its start for a block's handle. */
const TEXT_COLUMN = "mx-auto max-w-204 px-16 max-md:px-4";

/**
 * A suggestion said in words, with undoing or accepting it. Where the page
 * has room beside the text it is a card in the margin, level with the change.
 * Otherwise it is a card as wide as the text, floating over the line above
 * the change.
 */
function SuggestionCard({
	suggestion,
	at,
	onAccept,
	onUndo,
}: {
	suggestion: PendingSuggestion;
	at: SuggestionCardAt;
	onAccept: () => void;
	onUndo: () => void;
}) {
	const mark = (
		<span className="grid size-7 shrink-0 place-items-center rounded-full bg-suggestion/15 text-suggestion">
			{suggestion.by.kind === "agent" ? (
				<Sparkles aria-hidden size={14} />
			) : (
				<PenLine aria-hidden size={14} />
			)}
		</span>
	);
	const settle = (
		<>
			<button
				type="button"
				onClick={onUndo}
				className="focus-ring h-7 shrink-0 rounded-full border border-border-strong px-3 text-soft-foreground text-xs transition-colors hover:bg-hover"
			>
				Undo
			</button>
			<button
				type="button"
				onClick={onAccept}
				className="focus-ring h-7 shrink-0 rounded-full bg-suggestion px-3 font-medium text-primary-foreground text-xs transition-opacity hover:opacity-90"
			>
				Accept
			</button>
		</>
	);
	const label = `Suggestion from ${suggestion.by.name}`;
	if (at.side === "beside") {
		return (
			// biome-ignore lint/a11y/useSemanticElements: a fieldset draws a border and legend this has no use for.
			<div
				role="group"
				aria-label={label}
				style={{ top: at.top, left: at.left }}
				className="absolute z-10 flex w-66 flex-col gap-2 rounded-xl border border-border-strong bg-panel p-3"
			>
				<div className="flex items-center gap-2">
					{mark}
					<span className="min-w-0 truncate font-medium text-foreground text-xs">
						{suggestion.by.name}
					</span>
				</div>
				<p className="m-0 line-clamp-2 text-soft-foreground text-xs">{changeInWords(suggestion)}</p>
				<div className="flex justify-end gap-2">{settle}</div>
			</div>
		);
	}
	return (
		<div
			style={{ top: at.top }}
			className={cn("absolute inset-x-0 z-10", at.side === "above" && "-translate-y-full")}
		>
			{/* As wide as the text it is about. */}
			<div className={TEXT_COLUMN}>
				{/* biome-ignore lint/a11y/useSemanticElements: a fieldset draws a border and legend this has no use for. */}
				<div
					role="group"
					aria-label={label}
					className="flex items-center gap-2.5 rounded-xl border border-border-strong bg-panel py-2 pr-2 pl-2.5 shadow-popover"
				>
					{mark}
					<span className="min-w-0 flex-1 truncate text-soft-foreground text-xs">
						<span className="font-medium text-foreground">{suggestion.by.name}</span>{" "}
						{lowerFirst(changeInWords(suggestion))}
					</span>
					{settle}
				</div>
			</div>
		</div>
	);
}

/** What a suggestion would do, as a sentence that follows whose it is. */
function changeInWords({ removes, adds }: PendingSuggestion): string {
	if (removes && adds) return `Changed \u201c${removes}\u201d to \u201c${adds}\u201d.`;
	if (adds) return `Added \u201c${adds}\u201d.`;
	if (removes) return `Removed \u201c${removes}\u201d.`;
	return "Changed the formatting.";
}

const lowerFirst = (sentence: string) => sentence.charAt(0).toLowerCase() + sentence.slice(1);

/** How a person's own changes land: made at once, or left as suggestions for the others to accept. */
type EditingMode = "editing" | "suggesting";

const EDITING_MODES: Record<EditingMode, { label: string; description: string; Icon: LucideIcon }> =
	{
		editing: { label: "Editing", description: "Change the document directly.", Icon: Pencil },
		suggesting: {
			label: "Suggesting",
			description: "Your changes wait for someone to accept them.",
			Icon: PenLine,
		},
	};

function useEditingMode(editor: Editor | null, as: Editing) {
	useEffect(() => (editor ? suggestingAs(editor, as.name) : undefined), [editor, as.name]);
	const suggesting = useEditorState({
		editor,
		selector: ({ editor: current }) => (current ? isSuggestChangesEnabled(current.state) : false),
	});
	const mode: EditingMode = suggesting ? "suggesting" : "editing";
	function setMode(chosen: EditingMode) {
		if (!editor) return;
		const change = chosen === "suggesting" ? enableSuggestChanges : disableSuggestChanges;
		change(editor.state, editor.view.dispatch);
		editor.commands.focus();
	}
	return [mode, setMode] as const;
}

/** Chooses how this person's changes land, beside the faces of who else is here. */
function EditingModePicker({
	mode,
	onChange,
}: {
	mode: EditingMode;
	onChange: (mode: EditingMode) => void;
}) {
	const { label, Icon } = EDITING_MODES[mode];
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				className={cn(
					"focus-ring inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm pr-1.5 pl-2 text-xs transition-colors",
					// Suggesting is lit, so nobody types thinking they are changing the document.
					mode === "suggesting"
						? "bg-suggestion/15 font-medium text-suggestion hover:bg-suggestion/25"
						: "text-soft-foreground hover:bg-hover data-popup-open:bg-hover",
				)}
			>
				<Icon aria-hidden size={13} />
				{label}
				<ChevronDown aria-hidden size={12} className="opacity-70" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{(["editing", "suggesting"] as const).map((option) => {
					const { label: name, description, Icon: OptionIcon } = EDITING_MODES[option];
					return (
						<DropdownMenuItem key={option} onClick={() => onChange(option)}>
							<OptionIcon aria-hidden />
							<span className="flex flex-1 flex-col">
								{name}
								<span className="text-muted-foreground text-xs">{description}</span>
							</span>
							<Check aria-hidden className={option === mode ? undefined : "invisible"} />
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * Where a suggestion's card goes: how far down the page, and either above or
 * below that point across the text, or beside the text from `left`.
 */
type SuggestionCardAt =
	| { top: number; side: "above" | "below" }
	| { top: number; left: number; side: "beside" };

/** An edit this person asked for and is waiting on, and where on the page its note sits. */
interface Awaited {
	threadId: string;
	top: number;
	left: number;
}

/**
 * The suggestions waiting in the document, each with where on the page its
 * card goes. With room beside `text`, that is the margin, level with the
 * change and under any card already there. Otherwise it is over the line
 * above where the change starts, or under where it ends when it is too near
 * the top of the page for a card to fit above.
 */
function useSuggestions(
	editor: Editor | null,
	page: React.RefObject<HTMLDivElement | null>,
	text: React.RefObject<HTMLElement | null>,
) {
	const pending = useEditorState({
		editor,
		selector: ({ editor: current }) => (current ? pendingSuggestions(current.state.doc) : []),
		equalityFn: (before, after) => JSON.stringify(before) === JSON.stringify(after),
	});
	const [placed, setPlaced] = useState<{ suggestion: PendingSuggestion; at: SuggestionCardAt }[]>(
		[],
	);
	const place = useCallback(() => {
		const element = page.current;
		if (!editor || !element) return setPlaced([]);
		const downThePage = (inWindow: number) =>
			inWindow - element.getBoundingClientRect().top + element.scrollTop;
		const textEnds = (text.current?.offsetLeft ?? 0) + (text.current?.offsetWidth ?? 0);
		const roomBeside = element.clientWidth - textEnds;
		if (roomBeside >= SUGGESTION_BESIDE_WIDTH_PX + SUGGESTION_BESIDE_GAP_PX) {
			let free = 0;
			return setPlaced(
				[...(pending ?? [])]
					.sort((one, other) => one.from - other.from)
					.map((suggestion) => {
						const top = Math.max(downThePage(editor.view.coordsAtPos(suggestion.from).top), free);
						free = top + SUGGESTION_BESIDE_HEIGHT_PX + SUGGESTION_BESIDE_GAP_PX;
						return { suggestion, at: { top, left: textEnds, side: "beside" as const } };
					}),
			);
		}
		setPlaced(
			(pending ?? []).map((suggestion) => {
				const above = downThePage(editor.view.coordsAtPos(suggestion.from).top) - EDIT_OFFER_GAP_PX;
				const below =
					downThePage(editor.view.coordsAtPos(suggestion.to).bottom) + EDIT_OFFER_GAP_PX;
				return {
					suggestion,
					at:
						above >= SUGGESTION_CARD_ROOM_PX
							? { top: above, side: "above" as const }
							: { top: below, side: "below" as const },
				};
			}),
		);
	}, [editor, page, text, pending]);
	useLayoutEffect(place, [place]);
	// The text is laid out again when the page changes width, as it does going full screen, which moves what is beside it.
	useEffect(() => {
		const element = page.current;
		if (!element) return;
		const resized = new ResizeObserver(place);
		resized.observe(element);
		return () => resized.disconnect();
	}, [page, place]);
	return placed;
}

/** The room a suggestion's card needs above the text to sit clear of the page's top edge. */
const SUGGESTION_CARD_ROOM_PX = 52;

/** A card beside the text: as wide as its `w-66`, as tall as it gets, and the space kept around it. */
const SUGGESTION_BESIDE_WIDTH_PX = 264;
const SUGGESTION_BESIDE_HEIGHT_PX = 136;
const SUGGESTION_BESIDE_GAP_PX = 12;

/**
 * What can be done to the selected text, floating just above it: asking a
 * bot to change it, and formatting it. Nothing shows until text is selected,
 * so the page stays clear while the person writes.
 */
function SelectionMenu({
	editor,
	at,
	editWith,
	onHold,
}: {
	editor: Editor;
	/** Where in the window the menu's bottom left corner goes. */
	at: { top: number; left: number };
	/** The bot that can be asked to change the selected text, and how to start asking it. Without it, there is none. */
	editWith: { name: string; onStart: () => void } | undefined;
	/**
	 * Told to keep the menu up while the person is in a part of it that takes
	 * the focus from the text: the dropdown of kinds, or the box for a link.
	 */
	onHold: (held: boolean) => void;
}) {
	const [linking, setLinking] = useState(false);
	/** The selected text stays marked while the link is typed, when the selection itself is in the box. */
	function startLinking() {
		const { from, to } = editor.state.selection;
		editor.view.dispatch(editor.state.tr.setMeta(editTarget, { from, to }));
		onHold(true);
		setLinking(true);
	}
	function stopLinking() {
		editor.view.dispatch(editor.state.tr.setMeta(editTarget, null));
		setLinking(false);
		onHold(false);
		editor.commands.focus();
	}

	// Starts over the selection's first word, moved left where it would run off the window.
	const menu = useRef<HTMLDivElement>(null);
	const [left, setLeft] = useState(at.left);
	useLayoutEffect(() => {
		const roomAcross =
			window.innerWidth - (menu.current?.offsetWidth ?? 0) - SELECTION_MENU_MARGIN_PX;
		setLeft(Math.max(SELECTION_MENU_MARGIN_PX, Math.min(at.left, roomAcross)));
	}, [at.left]);
	// In the window, not the page: the page clips what reaches past its edges, as a menu over its first line does.
	return createPortal(
		<div
			ref={menu}
			role="toolbar"
			aria-label="Selected text"
			style={{ top: at.top, left }}
			// Keeps the selection, which a press anywhere else would clear. A press in the link's box places its caret.
			onMouseDown={(event) => {
				if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
			}}
			className="fixed z-40 flex -translate-y-full items-center gap-0.5 rounded-lg border border-border-strong bg-panel p-1 shadow-popover"
		>
			{linking ? (
				<LinkBox editor={editor} onDone={stopLinking} />
			) : (
				<>
					{editWith && (
						<>
							<Tooltip side="top" label={`Ask ${editWith.name}`}>
								<button
									type="button"
									onClick={editWith.onStart}
									className="focus-ring flex h-6 items-center gap-1.5 rounded-md px-2 font-medium text-suggestion text-xs transition-colors hover:bg-hover"
								>
									<Sparkles aria-hidden size={13} />
									Edit with bot
								</button>
							</Tooltip>
							<MenuDivider />
						</>
					)}
					<BlockKindPicker editor={editor} onOpenChange={onHold} />
					<MenuDivider />
					<FormatButton editor={editor} label="Bold" Icon={Bold} mark="bold" />
					<FormatButton editor={editor} label="Italic" Icon={Italic} mark="italic" />
					<FormatButton editor={editor} label="Underline" Icon={Underline} mark="underline" />
					<FormatButton editor={editor} label="Strikethrough" Icon={Strikethrough} mark="strike" />
					<MenuDivider />
					<LinkButton editor={editor} onClick={startLinking} />
				</>
			)}
		</div>,
		document.body,
	);
}

const MenuDivider = () => <span aria-hidden className="mx-0.5 h-4 w-px bg-border-strong" />;

/** Opens the box for a link, lit while the selected text is one. */
function LinkButton({ editor, onClick }: { editor: Editor; onClick: () => void }) {
	const linked = useEditorState({
		editor,
		selector: ({ editor: current }) => current.isActive("link"),
	});
	return (
		<IconButton
			label="Link"
			side="top"
			aria-pressed={linked}
			onClick={onClick}
			className={cn(linked && "bg-hover-strong text-foreground")}
		>
			<Link2 aria-hidden />
		</IconButton>
	);
}

/**
 * Where the selected text's link is typed, in the menu's place. Enter links
 * the text, or unlinks it when the box is empty, and Escape leaves it as it was.
 */
function LinkBox({ editor, onDone }: { editor: Editor; onDone: () => void }) {
	const linkedTo: unknown = editor.getAttributes("link").href;
	const [address, setAddress] = useState(typeof linkedTo === "string" ? linkedTo : "");
	// The person clicked Link to open this box, so typing goes here.
	const field = useRef<HTMLInputElement>(null);
	useEffect(() => field.current?.select(), []);
	function apply() {
		const link = editor.chain().focus().extendMarkRange("link");
		if (address.trim() === "") link.unsetLink().run();
		else link.setLink({ href: withScheme(address.trim()) }).run();
		onDone();
	}
	return (
		<form
			className="flex items-center gap-1"
			onSubmit={(event) => {
				event.preventDefault();
				apply();
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

/** The least room the menu keeps from the window's edge. */
const SELECTION_MENU_MARGIN_PX = 16;

/** Says what kind of block the selected text is, by its icon and name, and turns it into another. */
function BlockKindPicker({
	editor,
	onOpenChange,
}: {
	editor: Editor;
	onOpenChange: (open: boolean) => void;
}) {
	const current = useEditorState({
		editor,
		selector: ({ editor: now }) => blockKindAt(now),
	});
	const shown = BLOCK_KINDS.find(({ kind }) => kind === current) ?? BLOCK_KINDS[0];
	return (
		<DropdownMenu onOpenChange={onOpenChange}>
			<Tooltip side="top" label="Text style">
				<DropdownMenuTrigger
					aria-label={`Text style, now ${shown.label}`}
					className="focus-ring flex h-6 items-center gap-1.5 rounded-md pr-1 pl-1.5 text-foreground text-xs transition-colors hover:bg-hover data-popup-open:bg-hover"
				>
					<shown.Icon aria-hidden size={14} className="text-muted-foreground" />
					{shown.label}
					<ChevronDown aria-hidden size={12} className="text-subtle-foreground" />
				</DropdownMenuTrigger>
			</Tooltip>
			<DropdownMenuContent align="start" className="min-w-56">
				<p className="m-0 px-2.5 pt-2 pb-1 text-muted-foreground text-xs">Turn into</p>
				{BLOCK_KINDS.map(({ kind, label, Icon, typed }) => (
					<DropdownMenuItem key={kind} onClick={() => turnInto(editor, kind)}>
						<BlockIcon Icon={Icon} />
						<span className="flex-1">{label}</span>
						<TypedHint typed={typed} />
						<Check aria-hidden className={kind === current ? "text-suggestion" : "invisible"} />
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** A way of marking the selected text, such as bold, lit while the text is marked so. */
function FormatButton({
	editor,
	label,
	Icon,
	mark,
}: {
	editor: Editor;
	label: string;
	Icon: LucideIcon;
	mark: "bold" | "italic" | "underline" | "strike";
}) {
	const active = useEditorState({
		editor,
		selector: ({ editor: current }) => current.isActive(mark),
	});
	const toggle = () => editor.chain().focus().toggleMark(mark).run();
	return (
		<IconButton
			label={label}
			side="top"
			aria-pressed={active}
			onClick={toggle}
			className={cn(active && "bg-hover-strong text-foreground")}
		>
			<Icon aria-hidden />
		</IconButton>
	);
}

/** The bot a person asks for an edit. */
export interface AskedBot {
	agentId: string;
	name: string;
}

/**
 * The text a request is about, with where it sits in the document, for the
 * bot to find it by. A request made on an empty line is about no text: it
 * asks for something to be written there.
 */
interface AskedAbout {
	/** The words the person selected, or none on an empty line. */
	selected: string;
	/** The whole of the paragraphs those words are in. */
	passage: string;
	/** The nearest heading above them, if the document has one there. */
	heading: string | undefined;
	/** The block before theirs, if there is one: where new writing goes after. */
	before: string | undefined;
}

/** What a person asked for, and the text it is about. */
interface Asked extends AskedAbout {
	instruction: string;
}

/** The box open for an instruction: what it is about, and where on the page it sits. */
interface Asking extends AskedAbout {
	top: number;
	left: number;
}

function askedAbout(document: Node, { from, to }: Range): AskedAbout {
	const [start, end] = [document.resolve(from), document.resolve(to)];
	let heading: string | undefined;
	document.forEach((block, offset) => {
		if (offset <= from && block.type.name === "heading") heading = block.textContent;
	});
	const blockIndex = start.index(0);
	return {
		selected: document.textBetween(from, to, "\n"),
		passage: document.textBetween(start.start(), end.end(), "\n"),
		heading,
		before: blockIndex > 0 ? document.child(blockIndex - 1).textContent : undefined,
	};
}

/**
 * Says what goes in an empty block, in the block's own type: a title and the
 * headings always, so an outline shows before it is written, and a plain
 * paragraph only while the caret is in it, or while it is the whole document.
 */
const EmptyHints = Placeholder.configure({
	showOnlyCurrent: false,
	placeholder: ({ editor, node, hasAnchor }) => {
		if (node.type.name === "heading") return node.attrs.level === 1 ? "Title" : "Heading";
		if (node.type.name !== "paragraph") return "";
		return hasAnchor || editor.isEmpty ? "Write something, or press / for blocks" : "";
	},
});

/** Shows where a block being dragged will land, as a line the style sheet colours. */
const DropLine = Dropcursor.configure({ color: false, width: 3, class: "drop-line" });

/** Carries the text a request is about, or `null` once the request is sent or dropped. */
const editTarget = new PluginKey<DecorationSet>("editTarget");

/**
 * Keeps the text a request is about marked while the person writes their
 * instruction, when the selection itself has moved into the box.
 */
const EditTarget = Extension.create({
	name: "editTarget",
	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: editTarget,
				state: {
					init: () => DecorationSet.empty,
					apply(transaction, marked) {
						const target: Range | null | undefined = transaction.getMeta(editTarget);
						if (target === null) return DecorationSet.empty;
						if (target === undefined) return marked.map(transaction.mapping, transaction.doc);
						return DecorationSet.create(transaction.doc, [
							Decoration.inline(target.from, target.to, { class: "edit-target" }),
						]);
					},
				},
				props: {
					decorations: (state) => editTarget.getState(state),
				},
			}),
		];
	},
});

/** The selected text, and where on the page its menu and the box for a request go. */
interface SelectionMenuAt {
	selected: Range;
	/** Where the menu goes in the window: just above the start of the selection. */
	menu: { top: number; left: number };
	/** The bottom of the selection's last line, down the page. */
	below: number;
	/** The start of the selection, across the page. */
	left: number;
}

/**
 * Where the menu for the selected text goes, once the person has finished
 * selecting it, while `offered` is true. While `held`, it stays where it is:
 * a dropdown opened from the menu takes the focus, which would otherwise
 * read as the person having left the text.
 */
function useSelectionMenu(
	editor: Editor | null,
	page: React.RefObject<HTMLDivElement | null>,
	{ offered, held }: { offered: boolean; held: boolean },
): SelectionMenuAt | undefined {
	const selected = useEditorState({
		editor,
		selector: ({ editor: current }) => {
			if (!current?.isFocused || current.state.selection.empty) return null;
			// A block picked up by its handle is selected too, and is being moved, not formatted.
			if (!(current.state.selection instanceof TextSelection)) return null;
			const { from, to } = current.state.selection;
			return { from, to };
		},
		equalityFn: (before, after) => before?.from === after?.from && before?.to === after?.to,
	});
	// A menu that followed the pointer while it dragged out a selection would sit under it.
	// Only a press on the text counts: one on the menu itself is a click on one of its actions.
	const [dragging, setDragging] = useState(false);
	useEffect(() => {
		if (!editor) return;
		const text = editor.view.dom;
		const down = () => setDragging(true);
		const up = () => setDragging(false);
		text.addEventListener("pointerdown", down);
		window.addEventListener("pointerup", up);
		return () => {
			text.removeEventListener("pointerdown", down);
			window.removeEventListener("pointerup", up);
		};
	}, [editor]);
	const [offer, setOffer] = useState<SelectionMenuAt>();
	const place = useCallback(() => {
		const element = page.current;
		if (held) return;
		if (!editor || !element || !selected || dragging || !offered) return setOffer(undefined);
		const frame = element.getBoundingClientRect();
		const [start, end] = [
			editor.view.coordsAtPos(selected.from),
			editor.view.coordsAtPos(selected.to),
		];
		// Scrolled out of sight, the selection has nowhere to show a menu.
		if (start.top < frame.top || start.top > frame.bottom) return setOffer(undefined);
		setOffer({
			selected,
			menu: { top: start.top - EDIT_OFFER_GAP_PX, left: start.left },
			below: end.bottom - frame.top + element.scrollTop + EDIT_OFFER_GAP_PX,
			left: start.left - frame.left,
		});
	}, [editor, page, selected, dragging, offered, held]);
	useLayoutEffect(place, [place]);
	// The menu sits in the window, so it is placed again whenever the text moves under it.
	useEffect(() => {
		const element = page.current;
		if (!element) return;
		element.addEventListener("scroll", place);
		window.addEventListener("resize", place);
		return () => {
			element.removeEventListener("scroll", place);
			window.removeEventListener("resize", place);
		};
	}, [page, place]);
	return offer;
}

/** The space between the selected text and the menu above it or the box below it. */
const EDIT_OFFER_GAP_PX = 6;

/**
 * Where a person tells the bot what to change, under the text they selected,
 * or what to write, under the empty line they are on. What the bot does comes
 * back into the document as a suggestion.
 */
function AskBox({
	at,
	bot,
	writing,
	onAsk,
	onCancel,
	onClickAway,
}: {
	at: { top: number; left: number };
	bot: AskedBot;
	/** Asked from an empty line, for something to be written there, and not about selected text. */
	writing: boolean;
	onAsk: (instruction: string) => Promise<void>;
	/** The person pressed Escape in the box, and goes back to the text. */
	onCancel: () => void;
	/** The person pressed somewhere else, which is where they are now. */
	onClickAway: () => void;
}) {
	const [instruction, setInstruction] = useState("");
	const [state, setState] = useState<"writing" | "sending" | "failed">("writing");
	const unsendable = instruction.trim() === "" || state === "sending";
	// The person clicked to open this box, so typing goes here.
	const field = useRef<HTMLTextAreaElement>(null);
	useEffect(() => field.current?.focus(), []);
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const pressed = (event: PointerEvent) => {
			if (event.target instanceof Element && !box.current?.contains(event.target)) onClickAway();
		};
		document.addEventListener("pointerdown", pressed);
		return () => document.removeEventListener("pointerdown", pressed);
	}, [onClickAway]);
	async function send() {
		if (unsendable) return;
		setState("sending");
		try {
			await onAsk(instruction.trim());
		} catch {
			setState("failed");
		}
	}
	return (
		<div
			ref={box}
			style={at}
			className="focus-ring-within absolute z-10 flex w-88 max-w-full flex-col rounded-xl border border-border-strong bg-panel shadow-popover"
		>
			<div className="flex items-end gap-2 py-1.5 pr-1.5 pl-2.5">
				<span className="grid size-7 shrink-0 place-items-center text-suggestion">
					<Sparkles aria-hidden size={14} />
				</span>
				<textarea
					ref={field}
					rows={1}
					aria-label={`What ${bot.name} should ${writing ? "write" : "change"}`}
					placeholder={`Tell ${bot.name} what to ${writing ? "write" : "change"}`}
					value={instruction}
					onChange={(event) => setInstruction(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") onCancel();
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							void send();
						}
					}}
					className="field-sizing-content max-h-40 min-w-0 flex-1 resize-none bg-transparent py-1 text-foreground text-sm outline-none placeholder:text-subtle-foreground"
				/>
				<button
					type="button"
					aria-label="Send"
					disabled={unsendable}
					onClick={send}
					className="focus-ring grid size-7 shrink-0 place-items-center rounded-full bg-suggestion text-primary-foreground transition-opacity hover:opacity-90 disabled:bg-chip-strong disabled:text-disabled-foreground"
				>
					<ArrowUp aria-hidden size={15} />
				</button>
			</div>
			{state === "failed" && (
				<p role="alert" className="m-0 px-3 pb-2 text-destructive-text text-xs">
					{bot.name} could not be asked. Try again.
				</p>
			)}
		</div>
	);
}

/** How wide the box is, as its `w-88`, and the least room it keeps from the page's edge. */
const ASK_BOX_WIDTH_PX = 352;
const ASK_BOX_MARGIN_PX = 16;

/**
 * The edits people asked a bot for from inside this document, which everyone
 * in it sees. The API reads the same list to know which of a bot's changes
 * to show as suggestions.
 */
function useEditRequests(provider: HocuspocusProvider) {
	const requests = provider.document.getMap<EditRequest>(LIVE_DOCUMENT_EDIT_REQUESTS);
	const [waiting, setWaiting] = useState<(EditRequest & { threadId: string })[]>([]);
	useEffect(() => {
		const update = () =>
			setWaiting(
				[...requests.entries()]
					.filter(([, request]) => !request.answered)
					.map(([threadId, request]) => ({ threadId, ...request })),
			);
		update();
		requests.observe(update);
		return () => requests.unobserve(update);
	}, [requests]);
	return {
		waiting,
		add: (threadId: string, request: EditRequest) => void requests.set(threadId, request),
		/** Stops showing the request. The bot's change for it, if one comes, is still a suggestion. */
		dismiss: (threadId: string) => {
			const request = requests.get(threadId);
			if (request) requests.set(threadId, { ...request, answered: true });
		},
	};
}

/**
 * Asks `bot` for an edit to the document by starting a thread with it in the
 * pod's chat, where the bot answers and the request stays on record. Answers
 * the thread's id.
 */
async function askForEdit({
	workspaceId,
	podId,
	artifactId,
	title,
	bot,
	asked,
}: {
	workspaceId: string;
	podId: string;
	artifactId: string;
	title: string;
	bot: AskedBot;
	asked: Asked;
}): Promise<string> {
	const chat = await Effect.runPromise(
		client.api.chats.openPodChat({ params: { workspace: workspaceId, podId } }),
	);
	const started = await Effect.runPromise(
		client.api.chats.startThread({
			params: { conversationId: chat.id },
			payload: {
				id: uuidv4(),
				hostAgentId: bot.agentId,
				message: [
					`Please edit the document "${title}" (artifact ${artifactId}).`,
					asked.heading ? `Where: under the heading "${asked.heading}".` : "",
					...(asked.selected === "" ? whereToWrite(asked) : whatToChange(asked)),
					"Make the change with artifact_edit. It will be shown to me in the document as a suggestion to accept or reject.",
				]
					.filter(Boolean)
					.join("\n\n"),
			},
		}),
	);
	return started.conversation.id;
}

/** A request about selected text, as the bot reads it. */
const whatToChange = (asked: Asked) => [
	`The text I selected:\n\n${quoted(asked.selected)}`,
	asked.passage === asked.selected ? "" : `The paragraph it is in:\n\n${quoted(asked.passage)}`,
	`What to change: ${asked.instruction}`,
];

/** A request made on an empty line, as the bot reads it: where the line is, and what to write on it. */
const whereToWrite = (asked: Asked) => [
	asked.before
		? `I am on an empty line right after this text:\n\n${quoted(asked.before)}`
		: "I am on an empty line at the start of the document.",
	`What to write there: ${asked.instruction}`,
];

/** Whether everything typed here has reached the API, which keeps the document. */
function useSaved(provider: HocuspocusProvider) {
	const [saved, setSaved] = useState(!provider.hasUnsyncedChanges);
	useEffect(() => {
		const read = () => setSaved(!provider.hasUnsyncedChanges);
		read();
		provider.on("unsyncedChanges", read);
		return () => {
			provider.off("unsyncedChanges", read);
		};
	}, [provider]);
	return saved;
}

/** Text as a markdown quote, line by line. */
const quoted = (text: string) => `> ${text.replaceAll("\n", "\n> ")}`;

/** Replaces the document with a Word file's content, for everyone in it. */
export type WordImport = (file: File) => Promise<void>;

/** Something the person should know about the document, in a row across the top of it. */
function Notice({ children }: { children: ReactNode }) {
	return (
		<div
			role="alert"
			className="flex items-center gap-3 border-border border-b bg-chip px-4 py-2 text-foreground text-xs"
		>
			{children}
		</div>
	);
}

/** What an import left out of the document, as the person is told it. */
function imagesLeftOutInWords(count: number): string {
	const which =
		count === 1 ? "1 image in the Word file was" : `${count} images in the Word file were`;
	const megabytes = MAX_ARTIFACT_IMAGE_BYTES / BYTES_PER_MEGABYTE;
	return `${which} left out. A document shows PNG, JPEG, GIF and WebP images of up to ${megabytes} MB, saved inside the file.`;
}

const BYTES_PER_MEGABYTE = 1024 * 1024;

/** Why a Word file wasn't imported, as the person is told it. */
function importFailureInWords(failure: unknown): string {
	const why =
		failure instanceof ImageNotKept
			? failureMessage(failure.cause)
			: "It couldn't be read as a Word document";
	return `The Word file wasn't imported, so the document is as it was. ${why}.`;
}

/**
 * Saves the document as a .docx. The API builds the file from its own copy,
 * which holds what everyone has typed.
 */
export function downloadAsWord(podId: string, artifactId: string) {
	const link = document.createElement("a");
	link.href = `${apiBaseUrl}/pods/${podId}/artifacts/${artifactId}/word`;
	link.download = "";
	link.click();
}

/** Everyone else in the document as a row of faces, each ringed in its caret's colour and named on hover. */
function Others({ others }: { others: readonly Other[] }) {
	if (others.length === 0) return null;
	return (
		<ul aria-label="Also here" className="m-0 mr-1 flex list-none items-center p-0">
			{others.map(({ clientId, participant }) => (
				<li key={clientId} className="-ml-1 first:ml-0">
					<Tooltip label={participant.name}>
						<span
							role="img"
							aria-label={participant.name}
							style={{ "--tw-ring-color": participant.color } as CSSProperties}
							// The faces name themselves natively on hover, which would show beside the tooltip.
							className="block rounded-full border-2 border-list ring-2 [&>*]:pointer-events-none"
						>
							{participant.agent ? (
								<AgentAvatar {...participant.agent} size={OTHER_FACE_PX} />
							) : (
								<PersonAvatar
									person={{ ...participant, email: participant.email ?? "" }}
									size={OTHER_FACE_PX}
								/>
							)}
						</span>
					</Tooltip>
				</li>
			))}
		</ul>
	);
}

const OTHER_FACE_PX = 22;

/**
 * What each participant tells the others about themselves, as the sync layer
 * carries it. A person says who they are; a bot's comes from the API
 * (`artifacts/live.ts` in core), with the face it is drawn with.
 */
const participantSchema = Schema.Struct({
	name: Schema.String,
	/** Their caret's colour, as CSS. */
	color: Schema.String,
	email: Schema.optional(Schema.String),
	image: Schema.optional(Schema.NullOr(Schema.String)),
	agent: Schema.optional(
		Schema.Struct({ color: agentColorSchema, face: agentFaceSchema, shape: agentShapeSchema }),
	),
});
type Participant = typeof participantSchema.Type;

/** Someone else in the document, by the connection they are on: one person in two windows is two. */
interface Other {
	clientId: number;
	participant: Participant;
}

/** Everyone else in the document, bots included. */
function useOthers(provider: HocuspocusProvider): Other[] {
	const [others, setOthers] = useState<Other[]>([]);
	useEffect(() => {
		const awareness = provider.awareness;
		if (!awareness) return;
		const read = () =>
			setOthers(
				[...awareness.getStates()].flatMap(([clientId, state]) => {
					const participant = Schema.decodeUnknownOption(participantSchema)(state.user);
					return clientId === awareness.clientID || participant._tag === "None"
						? []
						: [{ clientId, participant: participant.value }];
				}),
			);
		read();
		awareness.on("change", read);
		return () => awareness.off("change", read);
	}, [provider]);
	return others;
}

function liveDocumentUrl(podId: string, artifactId: string) {
	const url = new URL(
		`${apiBaseUrl}/pods/${podId}/artifacts/${artifactId}/live`,
		window.location.origin,
	);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	// The API lets in only an editor built for the schema the document is kept in.
	url.searchParams.set("schema", String(LIVE_DOCUMENT_SCHEMA));
	return url.href;
}

/** A caret colour that stays the same for a name, so a person keeps theirs between visits. */
function caretColor(name: string) {
	let sum = 0;
	for (const character of name) sum += character.charCodeAt(0);
	return CARET_COLORS[sum % CARET_COLORS.length] ?? CARET_COLORS[0];
}

const CARET_COLORS = ["#7c3aed", "#db2777", "#ea580c", "#2563eb", "#059669"] as const;
