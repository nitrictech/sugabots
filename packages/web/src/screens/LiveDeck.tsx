import type { HocuspocusProvider } from "@hocuspocus/provider";
import { imageTypeOf, MAX_ARTIFACT_IMAGE_BYTES } from "@sugabots/contracts";
import { holdsSuggestion } from "@sugabots/contracts/live-document";
import { layoutOf } from "@sugabots/contracts/live-slides";
import type { SlideLayout } from "@sugabots/contracts/slide-layouts";
import { DOMSerializer, type Node } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { type Editor, useEditorState } from "@tiptap/react";
import {
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	LayoutTemplate,
	SquarePlus,
	X,
} from "lucide-react";
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { uploadArtifactImage } from "@/lib/artifacts.ts";
import {
	addImage,
	addSlide,
	addTextBox,
	type BoxPos,
	canResetLayout,
	changeLayout,
	LAYOUT_NAMES,
	moveSlideTo,
	placeOfMovedSlide,
	removeSlide,
	resetLayout,
	type SlidePos,
	selectSlide,
	slideIndexIn,
	slidesOf,
	whereFollowedBoxIs,
} from "@/lib/deck.ts";
import { failureMessage } from "@/lib/failure.ts";
import type { KeepImage } from "@/lib/file-import.ts";
import { type FollowedNode, followNode, keyOfFollowedNode } from "@/lib/followed-node.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import {
	importPowerPointFile,
	MAX_IMPORTED_SLIDES,
	type PowerPointImported,
} from "@/lib/powerpoint-import.ts";
import { dispatchAsOneChange } from "@/lib/suggesting.ts";
import {
	type PendingSuggestion,
	pendingSuggestions,
	settlingSuggestion,
} from "@/lib/suggestions.ts";
import { IconButton } from "@/ui/icon-button.tsx";
import { BoxOutlines } from "./box-outlines.tsx";
import { DeckPresent } from "./DeckPresent.tsx";
import { boxPreviewOf, deckStage, drawnSlideBody, slideInView } from "./deck-stage.ts";
import { LayoutPicker } from "./LayoutPicker.tsx";
import { LiveDocumentText } from "./live-document-text.tsx";
import {
	type Editing,
	EditorBar,
	type FileImport,
	type ImportedFileKind,
	imagesLeftOutInWords,
	type LiveArtifact,
	type LiveConnection,
	Notice,
	OutOfDateNotice,
	SLIDE_SHOWN,
	useFileImport,
	useLiveConnection,
	useLiveEditor,
	useOthers,
} from "./live-editor.tsx";
import {
	type AskedBot,
	type Asking,
	askForEdit,
	EditorOverlays,
	SuggestionCard,
} from "./live-editor-overlays.tsx";
import { SlideStrip } from "./SlideStrip.tsx";
import { fitSlideText } from "./slide-drawing.tsx";
import { useSlideMenu } from "./slide-menu.tsx";

/** Starts presenting the deck being edited. */
export type Present = () => void;

/**
 * A `slides` deck being edited with everyone else who has it open, people
 * and bots, as a document is: what anyone types appears for all of them, and
 * it saves as it goes. Its slides are in a strip beside the stage, which
 * shows the slide being edited, with its notes under it.
 */
export function LiveDeck({
	workspaceId,
	artifact,
	title,
	as,
	bot,
	onPresent,
	onImport,
	presenceSlot,
	statusSlot,
}: {
	workspaceId: string;
	artifact: LiveArtifact;
	title: string;
	as: Editing;
	/** The bot people here can ask for edits: the one that made the deck, unless it has been removed. */
	bot: AskedBot | undefined;
	/** Given how to start presenting the deck once the editor is up, and `undefined` when it goes. */
	onPresent: (present: Present | undefined) => void;
	/** Given how to replace the deck with a PowerPoint file's slides once the editor is up, and `undefined` when it goes. */
	onImport: (importPowerPoint: FileImport | undefined) => void;
	/** Where the faces of the others in the deck are drawn: a place outside the page, such as its title bar. */
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
				<DeckEditor
					key={artifactId}
					connection={connection}
					title={title}
					as={as}
					bot={bot}
					onAsk={(bot, asked) => askForEdit({ workspaceId, podId, artifactId, title, bot, asked })}
					onPresent={onPresent}
					keepImage={keepImage}
					onPowerPointImport={onImport}
					presenceSlot={presenceSlot}
					statusSlot={statusSlot}
				/>
			)}
		</div>
	);
}

function DeckEditor({
	connection,
	title,
	as,
	bot,
	onAsk,
	onPresent,
	keepImage,
	onPowerPointImport,
	presenceSlot,
	statusSlot,
}: {
	connection: LiveConnection;
	title: string;
	as: Editing;
	bot: AskedBot | undefined;
	onAsk: Parameters<typeof EditorOverlays>[0]["onAsk"];
	onPresent: (present: Present | undefined) => void;
	/** Keeps an image from a PowerPoint file for the deck. */
	keepImage: KeepImage;
	onPowerPointImport: (importPowerPoint: FileImport | undefined) => void;
	presenceSlot: HTMLElement | null;
	statusSlot: HTMLElement | null;
}) {
	// What the stage draws under the slide's body, inside the editor, is put in this.
	const [underSlide, setUnderSlide] = useState<HTMLElement>();
	const addImageTo = useRef<(boxPos: BoxPos, file: File | undefined) => void>(undefined);
	const [extensions] = useState(() => [
		deckStage({
			// The editor draws it while it updates, which may be while React renders.
			onUnderSlide: (change) => queueMicrotask(() => setUnderSlide(change)),
			onAddImage: (boxPos, file) => addImageTo.current?.(boxPos, file),
		}),
	]);
	const { editor, slashKeys, outOfDate } = useLiveEditor({
		connection,
		title,
		as,
		extensions,
		className: "live-deck",
	});
	if (!editor) return null;
	const { provider, artifact } = connection;
	return (
		<DeckView
			editor={editor}
			provider={provider}
			artifact={{ podId: artifact.podId, artifactId: artifact.id }}
			title={title}
			as={as}
			bot={bot}
			onAsk={onAsk}
			onPresent={onPresent}
			keepImage={keepImage}
			onPowerPointImport={onPowerPointImport}
			presenceSlot={presenceSlot}
			statusSlot={statusSlot}
			slashKeys={slashKeys}
			outOfDate={outOfDate}
			underSlide={underSlide}
			addImageTo={addImageTo}
		/>
	);
}

/** The deck's editor once it is up: the strip of slides, and the stage with the slide being edited. */
function DeckView({
	editor,
	provider,
	artifact,
	title,
	as,
	bot,
	onAsk,
	onPresent,
	keepImage,
	onPowerPointImport,
	presenceSlot,
	statusSlot,
	slashKeys,
	outOfDate,
	underSlide,
	addImageTo,
}: {
	editor: Editor;
	provider: HocuspocusProvider;
	artifact: { podId: string; artifactId: string };
	title: string;
	as: Editing;
	bot: AskedBot | undefined;
	onAsk: Parameters<typeof EditorOverlays>[0]["onAsk"];
	onPresent: (present: Present | undefined) => void;
	keepImage: KeepImage;
	onPowerPointImport: (importPowerPoint: FileImport | undefined) => void;
	presenceSlot: HTMLElement | null;
	statusSlot: HTMLElement | null;
	slashKeys: Parameters<typeof EditorOverlays>[0]["slashKeys"];
	outOfDate: boolean;
	/** Drawn under the body of the slide on the stage, inside the editor (see `deck-stage.ts`). */
	underSlide: HTMLElement | undefined;
	/** Where the stage asks for an image for a slide's empty image box. */
	addImageTo: RefObject<((boxPos: BoxPos, file: File | undefined) => void) | undefined>;
}) {
	const others = useOthers(provider);
	const deck = useEditorState({
		editor,
		selector: ({ editor: current }) => {
			const { state } = current;
			const inView = slideInView(state);
			const slide = slidesOf(state.doc)[inView];
			return {
				doc: state.doc,
				current: inView,
				// The slide in view, to follow through others' changes: taken from the same state as
				// the document, so the two always agree.
				followed: slide && followNode(state, slide.pos),
			};
		},
		equalityFn: (before, after) => before.doc === after?.doc && before.current === after.current,
	});
	const current = deck.current;
	// The others are told which slide this person has in front of them (see `SlideStrip`).
	useEffect(() => {
		provider.awareness?.setLocalStateField(SLIDE_SHOWN, current);
	}, [provider, current]);
	const serializer = useMemo(() => DOMSerializer.fromSchema(editor.schema), [editor]);
	const page = useRef<HTMLDivElement>(null);
	// The positioned element holding the editor, and over it the outlines of the slide's boxes.
	const stage = useRef<HTMLDivElement>(null);
	const text = useRef<HTMLElement>(null);
	const [asking, setAsking] = useState<Asking>();
	const images = useImageAdding(editor, artifact, as.name);
	useEffect(() => {
		addImageTo.current = images.add;
	});
	const [presenting, setPresenting] = useState<number>();
	useEffect(() => {
		onPresent(() => setPresenting(slideInView(editor.state)));
		return () => onPresent(undefined);
	}, [editor, onPresent]);
	const importPowerPoint = useCallback(
		async (editing: Editor, file: File) =>
			leftOutInWords(await importPowerPointFile(editing, file, keepImage, as.name)),
		[keepImage, as.name],
	);
	const importNotice = useFileImport({
		editor,
		onImport: onPowerPointImport,
		importFile: importPowerPoint,
		kind: POWERPOINT_FILE,
		noun: "deck",
	});
	const slides = slidesOf(deck.doc);
	const shown = slides[current];
	const overflowing = useFittedStage(editor, stage, shown?.pos, shown?.node);
	const pending = useSlideSuggestions(
		editor,
		shown && { from: shown.pos, to: shown.pos + shown.node.nodeSize },
	);
	const pageWidth = useWidth(page);
	const beside = pending.length > 0 && pageWidth >= CARDS_BESIDE_MIN_PAGE_PX;
	const sideBySide = useMediaQuery(SIDE_BY_SIDE);
	const finePointer = useMediaQuery(FINE_POINTER);
	const editable = !outOfDate;
	// Moved, resized and deleted from their outlines and the slide's menu from Tailwind's `md`, as the strip's slides are dragged.
	const boxesEditable = shown !== undefined && editable && sideBySide;
	const slideMenu = useSlideMenu(editor, { slide: shown, editable, boxesEditable });
	if (!shown) return null;
	const change = (transaction: Transaction | undefined) => {
		if (transaction) dispatchAsOneChange(editor, transaction, as.name);
	};
	/** `index`, a slide's place in the strip or the pager, as the index of the slide there now, if there is one. */
	const slideNumbered = (index: number) => slideIndexIn(editor.state.doc, index);
	const settle = (suggestionId: string, how: "accept" | "reject") =>
		settlingSuggestion(suggestionId, how)(editor.state, editor.view.dispatch);
	const cards = (shape: "card" | "bar") =>
		pending.map((suggestion) => (
			<SuggestionCard
				key={suggestion.id}
				suggestion={suggestion}
				shape={shape}
				onAccept={() => settle(suggestion.id, "accept")}
				onUndo={() => settle(suggestion.id, "reject")}
			/>
		));
	function select(index: number) {
		const slide = slideNumbered(index);
		const selecting = slide === undefined ? undefined : selectSlide(editor.state, slide);
		if (selecting) editor.view.dispatch(selecting);
		// On a touch screen the keyboard would cover the slide just picked.
		if (!window.matchMedia(COARSE_POINTER).matches) editor.view.focus();
		page.current?.scrollTo({ top: 0 });
	}
	function resetShownLayout() {
		const resetting = resetLayout(editor.state, current);
		if (resetting) editor.view.dispatch(resetting);
	}
	/** Adds a text box to the slide shown, where one with no place said goes, to type in at once. */
	function addShownTextBox() {
		const adding = shown && addTextBox(editor.state, shown.pos, undefined);
		if (!adding) return;
		editor.view.dispatch(adding);
		editor.view.focus();
	}
	return (
		<>
			<EditorBar
				editor={editor}
				provider={provider}
				as={as}
				others={others}
				noun="deck"
				presenceSlot={presenceSlot}
				statusSlot={statusSlot}
			/>
			{outOfDate && <OutOfDateNotice noun="deck" />}
			{importNotice}
			{images.notice && (
				<DismissibleNotice onDismiss={images.dismiss}>{images.notice}</DismissibleNotice>
			)}
			{slideMenu.notice && (
				<DismissibleNotice onDismiss={slideMenu.dismissNotice}>
					{slideMenu.notice}
				</DismissibleNotice>
			)}
			<div className="flex min-h-0 flex-1 max-md:flex-col-reverse">
				<SlideStrip
					slides={deck.doc.children}
					current={current}
					others={others}
					serializer={serializer}
					editable={editable}
					onSelect={select}
					onAdd={(layout) => {
						change(addSlide(editor.state, current, layout));
						// As a suggestion the selection lands after what was added, so the new slide is chosen again.
						select(current + 1);
					}}
					onMove={(fromIndex, toIndex) => {
						const [from, to] = [slideNumbered(fromIndex), slideNumbered(toIndex)];
						if (from === undefined || to === undefined) return;
						const before = editor.state.doc;
						change(moveSlideTo(editor.state, from, to));
						select(placeOfMovedSlide(before, editor.state.doc, from, to));
					}}
					onRemove={(index) => {
						const slide = slideNumbered(index);
						if (slide !== undefined) change(removeSlide(editor.state, slide));
					}}
				/>
				<div ref={page} className="relative min-h-0 min-w-0 flex-1 overflow-y-auto">
					<div className="flex justify-center gap-6 px-8 pt-4 pb-8 max-md:px-4 max-md:pt-1">
						<section
							aria-label="Current slide"
							className="flex w-full min-w-0 max-w-240 flex-col gap-3"
						>
							<div className="flex items-center gap-2">
								{editable && (
									<LayoutPicker
										heading="Change layout"
										current={layoutOf(shown.node)}
										unavailable={
											holdsSuggestion(shown.node)
												? "Accept or undo the suggestions on this slide to change its layout."
												: undefined
										}
										onPick={(layout: SlideLayout) =>
											change(changeLayout(editor.state, current, layout))
										}
										onReset={canResetLayout(shown.node) ? resetShownLayout : undefined}
										className="focus-ring inline-flex h-8 min-w-0 items-center gap-1.5 rounded-sm px-2 text-soft-foreground text-xs transition-colors hover:bg-hover data-popup-open:bg-hover max-md:h-11 max-md:text-sm"
									>
										<LayoutTemplate aria-hidden size={16} strokeWidth={1.75} />
										{/* Cut short where a phone is too narrow for it beside the pager. */}
										<span className="truncate">{LAYOUT_NAMES[layoutOf(shown.node)]}</span>
										<ChevronDown aria-hidden size={12} className="text-subtle-foreground" />
									</LayoutPicker>
								)}
								{editable && (
									<IconButton
										label="Add text box"
										variant="bar"
										className="size-8 max-md:size-11"
										onClick={addShownTextBox}
									>
										<SquarePlus aria-hidden size={16} strokeWidth={1.75} />
									</IconButton>
								)}
								<span className="flex-1" />
								<SlidePager current={current} total={slides.length} onSelect={select} />
							</div>
							<div ref={stage} className="relative" {...slideMenu.stageProps}>
								<LiveDocumentText
									editor={editor}
									ref={text}
									className="min-w-0"
									page={page}
									askBoxOpen={asking !== undefined}
								/>
								{/* Only for a fine pointer: a touch drag is no move, and on a touch screen the outlines would take taps near a box's edge. */}
								{boxesEditable && finePointer && deck.followed && (
									<BoxOutlines
										// Its boxes are known by their place on the slide, which means nothing on another. The
										// slide is known by itself, not by its place in the deck, which others' changes shift.
										key={keyOfFollowedNode(deck.followed)}
										editor={editor}
										slide={shown}
										stage={stage}
										menuFor={slideMenu.box}
									/>
								)}
							</div>
						</section>
						{beside && (
							<CardsBeside editor={editor} pending={pending}>
								{cards("card")}
							</CardsBeside>
						)}
					</div>
					<EditorOverlays
						editor={editor}
						provider={provider}
						page={page}
						slashKeys={slashKeys}
						editable={editable}
						bot={bot}
						onAsk={onAsk}
						asking={asking}
						onAskingChange={setAsking}
						blockHandle={false}
					/>
				</div>
			</div>
			{underSlide &&
				createPortal(
					<>
						{overflowing && (
							<p role="status" className="slide-overflow">
								This slide has more than fits. Shorten it or split it into two slides.
							</p>
						)}
						{!beside && pending.length > 0 && (
							<div className="flex flex-col gap-2">{cards("bar")}</div>
						)}
					</>,
					underSlide,
				)}
			{presenting !== undefined && (
				<DeckPresent
					editor={editor}
					title={title}
					startAt={presenting}
					onExit={(at) => {
						setPresenting(undefined);
						select(at);
					}}
				/>
			)}
			{images.picker}
			{slideMenu.menu}
		</>
	);
}

const COARSE_POINTER = "(pointer: coarse)";

/** A mouse, a touchpad or a pen: a pointer that can grab a box's edge. */
const FINE_POINTER = "(pointer: fine)";

/** Something the person should know about the deck, across the top of it until they dismiss it. */
function DismissibleNotice({
	onDismiss,
	children,
}: {
	onDismiss: () => void;
	children: ReactNode;
}) {
	return (
		<Notice>
			<span className="min-w-0 flex-1">{children}</span>
			<IconButton label="Dismiss" onClick={onDismiss}>
				<X aria-hidden />
			</IconButton>
		</Notice>
	);
}

/**
 * Which slide is on the stage, written "2 / 3" and read out as "Slide 2 of
 * 3", between buttons that put the slide before it or after it there.
 */
function SlidePager({
	current,
	total,
	onSelect,
}: {
	/** The slide on the stage, by its place in the deck. */
	current: number;
	/** How many slides the deck has. */
	total: number;
	onSelect: (index: number) => void;
}) {
	return (
		<div className="inline-flex h-8 shrink-0 items-center rounded-sm border border-border-strong px-0.75 text-muted-foreground text-xs max-md:h-11 max-md:text-sm">
			<IconButton
				label="Previous slide"
				disabled={current === 0}
				onClick={() => onSelect(current - 1)}
				className={PAGER_BUTTON}
			>
				<ChevronLeft aria-hidden />
			</IconButton>
			<span className="px-1 tabular-nums">
				<span aria-hidden>
					{current + 1} / {total}
				</span>
				<span className="sr-only">
					Slide {current + 1} of {total}
				</span>
			</span>
			<IconButton
				label="Next slide"
				disabled={current === total - 1}
				onClick={() => onSelect(current + 1)}
				className={PAGER_BUTTON}
			>
				<ChevronRight aria-hidden />
			</IconButton>
		</div>
	);
}

/**
 * Merged over a pager's button: its corners one size under the pager's, so
 * its hover wash stays inside them; with no slide to go to it takes no hover
 * wash or tooltip; and on a phone it is sized for a thumb, as the layout's
 * button is.
 */
const PAGER_BUTTON =
	"rounded-xs disabled:pointer-events-none max-md:size-9 max-md:[&_svg]:size-4.5";

/** How wide the stage must be for the suggestions' cards to sit in a column beside the slide. */
const CARDS_BESIDE_MIN_PAGE_PX = 1000;

/**
 * Draws the text of the slide on the stage, the one starting at `slidePos`,
 * at the largest size at which it fits, as its drawings elsewhere are, each
 * time it changes, the stage changes width, or a box on it is drawn where a
 * drag has it, so the text fits the box as it is resized. Answers whether it
 * runs over even at the smallest.
 */
function useFittedStage(
	editor: Editor,
	stage: RefObject<HTMLDivElement | null>,
	slidePos: SlidePos | undefined,
	slide: Node | undefined,
) {
	const [overflowing, setOverflowing] = useState(false);
	const measure = useEffectEvent(() => {
		const element = stage.current;
		const body = slidePos === undefined ? undefined : drawnSlideBody(editor.view, slidePos);
		if (!element || !body || !slide) return;
		setOverflowing(fitSlideText(element, body, slide));
	});
	// biome-ignore lint/correctness/useExhaustiveDependencies: measured again whenever the slide changes.
	useLayoutEffect(() => measure(), [slidePos, slide]);
	useEffect(() => {
		const element = stage.current;
		if (!element) return;
		const remeasure = () => measure();
		const resized = new ResizeObserver(remeasure);
		resized.observe(element);
		element.addEventListener("load", remeasure, true);
		// Heard once the editor has drawn the transaction, so the dragged box is measured where it now is.
		let preview = boxPreviewOf(editor.state);
		const dragged = () => {
			const now = boxPreviewOf(editor.state);
			if (now === preview) return;
			preview = now;
			measure();
		};
		editor.on("transaction", dragged);
		return () => {
			resized.disconnect();
			element.removeEventListener("load", remeasure, true);
			editor.off("transaction", dragged);
		};
	}, [editor, stage]);
	return overflowing;
}

/** The suggestions waiting on the slide in `range`, or in it, in the order they appear. */
function useSlideSuggestions(editor: Editor, range: { from: number; to: number } | undefined) {
	return useEditorState({
		editor,
		selector: ({ editor: current }) =>
			range
				? pendingSuggestions(current.state.doc).filter(
						({ from, to }) => from < range.to && to > range.from,
					)
				: [],
		equalityFn: (before, after) => JSON.stringify(before) === JSON.stringify(after),
	});
}

/** How wide `element` is, kept up to date. */
function useWidth(element: RefObject<HTMLElement | null>) {
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const observed = element.current;
		if (!observed) return;
		const resized = new ResizeObserver(() => setWidth(observed.clientWidth));
		resized.observe(observed);
		return () => resized.disconnect();
	}, [element]);
	return width;
}

/**
 * The suggestions' cards in a column beside the slide, each level with what
 * it would change, and under the card above where they would overlap.
 */
function CardsBeside({
	editor,
	pending,
	children,
}: {
	editor: Editor;
	pending: readonly PendingSuggestion[];
	children: ReactNode[];
}) {
	const column = useRef<HTMLElement>(null);
	const [tops, setTops] = useState<number[]>([]);
	useLayoutEffect(() => {
		const element = column.current;
		if (!element) return;
		const start = element.getBoundingClientRect().top;
		let free = 0;
		setTops(
			pending.map(({ from }) => {
				const top = Math.max(editor.view.coordsAtPos(from).top - start, free);
				free = top + CARD_HEIGHT_PX + CARD_GAP_PX;
				return top;
			}),
		);
	}, [editor, pending]);
	return (
		<aside ref={column} aria-label="Suggestions" className="relative w-66 shrink-0">
			{children.map((card, index) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: each card is keyed by its suggestion inside.
					key={index}
					style={{ top: tops[index] ?? 0 }}
					className="absolute inset-x-0"
				>
					{card}
				</div>
			))}
		</aside>
	);
}

/** A card beside the slide: as tall as it gets, and the space kept between two. */
const CARD_HEIGHT_PX = 136;
const CARD_GAP_PX = 12;

/**
 * Adding an image to a slide's empty image box: from the picker that `add`
 * opens with no file, or from a file dropped there. The image is kept for the
 * deck as a Word file's images are kept for a document, then put in the box.
 * The box is followed from the moment the image is asked for, through
 * anybody's changes meanwhile, as the person picks a file and as it uploads
 * (see `followNode`), and the person is told if it is gone by the end.
 */
function useImageAdding(
	editor: Editor,
	artifact: { podId: string; artifactId: string },
	name: string,
) {
	const [notice, setNotice] = useState<string>();
	const input = useRef<HTMLInputElement>(null);
	const pickingFor = useRef<FollowedNode>(undefined);
	async function keep(box: FollowedNode, file: File) {
		setNotice(undefined);
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const type = imageTypeOf(bytes);
			if (!type || bytes.byteLength > MAX_ARTIFACT_IMAGE_BYTES) return setNotice(IMAGE_REFUSED);
			const src = await uploadArtifactImage(artifact, { type, bytes });
			const at = whereFollowedBoxIs(editor.state.doc, box);
			if (at === undefined) return setNotice(BOX_GONE);
			const adding = addImage(editor.state, at, { src, alt: file.name.replace(/\.[^.]*$/, "") });
			if (adding) dispatchAsOneChange(editor, adding, name);
		} catch (failure) {
			setNotice(`The image wasn't added. ${failureMessage(failure)}.`);
		}
	}
	return {
		notice,
		dismiss: () => setNotice(undefined),
		add: (boxPos: BoxPos, file: File | undefined) => {
			const box = followNode(editor.state, boxPos);
			if (!box) return;
			if (file) return void keep(box, file);
			pickingFor.current = box;
			input.current?.click();
		},
		picker: (
			<input
				ref={input}
				type="file"
				accept={IMAGE_TYPES}
				hidden
				onChange={(event) => {
					const [file] = event.target.files ?? [];
					const box = pickingFor.current;
					if (file && box !== undefined) void keep(box, file);
					event.target.value = "";
				}}
			/>
		),
	};
}

const POWERPOINT_FILE: ImportedFileKind = {
	name: "PowerPoint file",
	readAs: "a PowerPoint presentation",
};

/** What a PowerPoint file's import left out of the deck, as the person is told it, or `undefined` for nothing. */
function leftOutInWords({
	slidesLeftOut,
	imagesLeftOut,
	othersLeftOut,
}: PowerPointImported): string | undefined {
	const said = [
		...(slidesLeftOut > 0 ? [slidesLeftOutInWords(slidesLeftOut)] : []),
		...(imagesLeftOut > 0 ? [imagesLeftOutInWords(imagesLeftOut, POWERPOINT_FILE, "deck")] : []),
		...(othersLeftOut > 0 ? [othersLeftOutInWords(othersLeftOut)] : []),
	];
	return said.length > 0 ? said.join(" ") : undefined;
}

function slidesLeftOutInWords(count: number): string {
	const which = count === 1 ? "1 slide was" : `${count} slides were`;
	return `A deck takes the first ${MAX_IMPORTED_SLIDES} slides of a PowerPoint file, so ${which} left out.`;
}

function othersLeftOutInWords(count: number): string {
	const which =
		count === 1
			? "1 chart, video, SmartArt graphic or other thing in the PowerPoint file was"
			: `${count} charts, videos, SmartArt graphics or other things in the PowerPoint file were`;
	return `${which} left out. A deck keeps a slide's text, shapes, pictures, tables and notes, with their colours, fonts and places.`;
}

const IMAGE_TYPES = "image/png,image/jpeg,image/gif,image/webp";

const BOX_GONE = "The image wasn't added. The box it was for was deleted while it uploaded.";

const IMAGE_REFUSED = `That file isn't an image a deck can show. A deck shows PNG, JPEG, GIF and WebP images of up to ${MAX_ARTIFACT_IMAGE_BYTES / (1024 * 1024)} MB.`;
