import { Placeholder } from "@tiptap/extensions/placeholder";
import { type Editor, useEditorState } from "@tiptap/react";
import { cn } from "cn";
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { uploadArtifactImage } from "@/lib/artifacts.ts";
import type { KeepImage } from "@/lib/file-import.ts";
import {
	type PendingSuggestion,
	pendingSuggestions,
	settlingSuggestion,
} from "@/lib/suggestions.ts";
import { importWordFile } from "@/lib/word-import.ts";
import { Outline } from "./LiveDocumentOutline.tsx";
import { LiveDocumentText } from "./live-document-text.tsx";
import {
	type Editing,
	EditorBar,
	type FileImport,
	type ImportedFileKind,
	imagesLeftOutInWords,
	type LiveArtifact,
	type LiveConnection,
	OutOfDateNotice,
	useFileImport,
	useLiveConnection,
	useLiveEditor,
	useOthers,
} from "./live-editor.tsx";
import {
	type AskedBot,
	type Asking,
	askForEdit,
	EDIT_OFFER_GAP_PX,
	EditorOverlays,
	SuggestionCard,
} from "./live-editor-overlays.tsx";

/**
 * A `document` artifact being edited with everyone else who has it open,
 * people and bots: what anyone types appears for all of them, with a caret
 * for each. It saves as it goes, so there is nothing to save.
 */
export function LiveDocument({
	workspaceId,
	artifact,
	title,
	as,
	bot,
	onImport,
	presenceSlot,
	statusSlot,
}: {
	workspaceId: string;
	artifact: LiveArtifact;
	title: string;
	as: Editing;
	/** The bot people here can ask for edits: the one that made the document, unless it has been removed. */
	bot: AskedBot | undefined;
	/** Given how to replace the document with a Word file's content once the editor is up, and `undefined` when it goes. */
	onImport: (importWord: FileImport | undefined) => void;
	/** Where the faces of the others in the document are drawn: a place outside the page, such as its title bar. */
	presenceSlot: HTMLElement | null;
	/** Where it says whether everything typed is saved: a place outside the page, such as after its title. */
	statusSlot: HTMLElement | null;
}) {
	const connection = useLiveConnection(artifact);
	const { podId, id: artifactId } = artifact;
	const keepImage = useCallback<KeepImage>(
		(image) => uploadArtifactImage({ podId, artifactId }, image),
		[podId, artifactId],
	);
	return (
		<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-list">
			{connection && (
				<LiveEditor
					key={artifactId}
					connection={connection}
					title={title}
					as={as}
					bot={bot}
					onAsk={(bot, asked) => askForEdit({ workspaceId, podId, artifactId, title, bot, asked })}
					keepImage={keepImage}
					onWordImport={onImport}
					presenceSlot={presenceSlot}
					statusSlot={statusSlot}
				/>
			)}
		</div>
	);
}

function LiveEditor({
	connection,
	title,
	as,
	bot,
	onAsk,
	keepImage,
	onWordImport,
	presenceSlot,
	statusSlot,
}: {
	connection: LiveConnection;
	title: string;
	as: Editing;
	bot: AskedBot | undefined;
	onAsk: Parameters<typeof EditorOverlays>[0]["onAsk"];
	/** Keeps an image from a Word file for the document. */
	keepImage: KeepImage;
	onWordImport: (importWord: FileImport | undefined) => void;
	presenceSlot: HTMLElement | null;
	statusSlot: HTMLElement | null;
}) {
	const { editor, slashKeys, outOfDate } = useLiveEditor({
		connection,
		title,
		as,
		extensions: [EmptyHints],
		// Its own padding, not the page's, so the pointer is over the editor while in the
		// margin beside a block, where the block's handle shows.
		className: "live-document px-16 max-md:px-4",
	});
	const { provider } = connection;
	const others = useOthers(provider);
	const page = useRef<HTMLDivElement>(null);
	const text = useRef<HTMLElement>(null);
	const [asking, setAsking] = useState<Asking>();
	const suggestions = useSuggestions(editor, page, text);
	const settle = (suggestionId: string, how: "accept" | "reject") =>
		editor && settlingSuggestion(suggestionId, how)(editor.state, editor.view.dispatch);
	const importWord = useCallback(
		async (editing: Editor, file: File) => {
			const { imagesLeftOut } = await importWordFile(editing, file, keepImage);
			return imagesLeftOut > 0
				? imagesLeftOutInWords(imagesLeftOut, WORD_FILE, "document")
				: undefined;
		},
		[keepImage],
	);
	const importNotice = useFileImport({
		editor,
		onImport: onWordImport,
		importFile: importWord,
		kind: WORD_FILE,
		noun: "document",
	});
	if (!editor) return null;
	return (
		<>
			<EditorBar
				editor={editor}
				provider={provider}
				as={as}
				others={others}
				noun="document"
				presenceSlot={presenceSlot}
				statusSlot={statusSlot}
			/>
			{outOfDate && <OutOfDateNotice noun="document" />}
			{importNotice}
			<div ref={page} className="@container relative min-h-0 flex-1 overflow-y-auto">
				<Outline editor={editor} />
				<LiveDocumentText
					editor={editor}
					ref={text}
					className="mx-auto max-w-204 pt-14 pb-30 max-md:pt-6"
					page={page}
					askBoxOpen={asking !== undefined}
				/>
				<EditorOverlays
					editor={editor}
					provider={provider}
					page={page}
					slashKeys={slashKeys}
					editable={!outOfDate}
					bot={bot}
					onAsk={onAsk}
					asking={asking}
					onAskingChange={setAsking}
				/>
				{suggestions.map(({ suggestion, at }) => (
					<PlacedSuggestionCard
						key={suggestion.id}
						at={at}
						card={
							<SuggestionCard
								suggestion={suggestion}
								shape={at.side === "beside" ? "card" : "bar"}
								onAccept={() => settle(suggestion.id, "accept")}
								onUndo={() => settle(suggestion.id, "reject")}
							/>
						}
					/>
				))}
			</div>
		</>
	);
}

/** As wide as the document's text and padded as the editor pads it, with room at its start for a block's handle. */
const TEXT_COLUMN = "mx-auto max-w-204 px-16 max-md:px-4";

/**
 * A suggestion's card where the page has room for it. Where the page has
 * room beside the text it is in the margin, level with the change. Otherwise
 * it is as wide as the text, floating over the line above the change.
 */
function PlacedSuggestionCard({ at, card }: { at: SuggestionCardAt; card: ReactNode }) {
	if (at.side === "beside") {
		return (
			<div style={{ top: at.top, left: at.left }} className="absolute z-10">
				{card}
			</div>
		);
	}
	return (
		<div
			style={{ top: at.top }}
			className={cn("absolute inset-x-0 z-10", at.side === "above" && "-translate-y-full")}
		>
			{/* As wide as the text it is about. */}
			<div className={TEXT_COLUMN}>{card}</div>
		</div>
	);
}

/**
 * Where a suggestion's card goes: how far down the page, and either above or
 * below that point across the text, or beside the text from `left`.
 */
type SuggestionCardAt =
	| { top: number; side: "above" | "below" }
	| { top: number; left: number; side: "beside" };

/**
 * The suggestions waiting in the document, each with where on the page its
 * card goes. With room beside `text`, that is the margin, level with the
 * change and under any card already there. Otherwise it is over the line
 * above where the change starts, or under where it ends when it is too near
 * the top of the page for a card to fit above.
 */
function useSuggestions(
	editor: Editor | null,
	page: RefObject<HTMLDivElement | null>,
	text: RefObject<HTMLElement | null>,
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

const WORD_FILE: ImportedFileKind = { name: "Word file", readAs: "a Word document" };
