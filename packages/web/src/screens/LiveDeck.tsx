import type { HocuspocusProvider } from "@hocuspocus/provider";
import { imageTypeOf, MAX_ARTIFACT_IMAGE_BYTES } from "@sugabots/contracts";
import { holdsSuggestion } from "@sugabots/contracts/live-document";
import { layoutOf, SLIDE_BODY, SLIDE_COLUMN } from "@sugabots/contracts/live-slides";
import type { SlideLayout } from "@sugabots/contracts/slides-markdown";
import type { NestedOptions } from "@tiptap/extension-drag-handle";
import { DOMSerializer } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { type Editor, useEditorState } from "@tiptap/react";
import { ChevronDown, LayoutTemplate, X } from "lucide-react";
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
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
	changeLayout,
	LAYOUT_NAMES,
	moveSlideTo,
	placeOfMovedSlide,
	removeSlide,
	selectSlide,
	slidesOf,
} from "@/lib/deck.ts";
import { failureMessage } from "@/lib/failure.ts";
import type { KeepImage } from "@/lib/file-import.ts";
import { importPowerPointFile, type PowerPointImported } from "@/lib/powerpoint-import.ts";
import { dispatchAsOneChange } from "@/lib/suggesting.ts";
import {
	type PendingSuggestion,
	pendingSuggestions,
	settlingSuggestion,
} from "@/lib/suggestions.ts";
import { IconButton } from "@/ui/icon-button.tsx";
import { DeckPresent } from "./DeckPresent.tsx";
import { deckStage, slideInView } from "./deck-stage.ts";
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
	// What the stage draws under the slide's frame, inside the editor, is put in this.
	const [underSlide, setUnderSlide] = useState<HTMLElement>();
	const addImageTo = useRef<(column: number, file: File | undefined) => void>(undefined);
	const [extensions] = useState(() => [
		deckStage({
			// The editor draws it while it updates, which may be while React renders.
			onUnderSlide: (change) => queueMicrotask(() => setUnderSlide(change)),
			onAddImage: (column, file) => addImageTo.current?.(column, file),
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
	/** Drawn under the frame of the slide on the stage, inside the editor (see `deck-stage.ts`). */
	underSlide: HTMLElement | undefined;
	/** Where the stage asks for an image for a slide's empty image column. */
	addImageTo: RefObject<((column: number, file: File | undefined) => void) | undefined>;
}) {
	const others = useOthers(provider);
	const deck = useEditorState({
		editor,
		selector: ({ editor: current }) => ({
			doc: current.state.doc,
			current: slideInView(current.state),
		}),
		equalityFn: (before, after) => before.doc === after?.doc && before.current === after.current,
	});
	const current = deck.current;
	// The others are told which slide this person has in front of them (see `SlideStrip`).
	useEffect(() => {
		provider.awareness?.setLocalStateField(SLIDE_SHOWN, current);
	}, [provider, current]);
	const serializer = useMemo(() => DOMSerializer.fromSchema(editor.schema), [editor]);
	const page = useRef<HTMLDivElement>(null);
	const frame = useRef<HTMLDivElement>(null);
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
	const overflowing = useFittedStage(editor, frame, shown?.pos, shown?.node);
	const pending = useSlideSuggestions(
		editor,
		shown && { from: shown.pos, to: shown.pos + shown.node.nodeSize },
	);
	const pageWidth = useWidth(page);
	const beside = pending.length > 0 && pageWidth >= CARDS_BESIDE_MIN_PAGE_PX;
	if (!shown) return null;
	const editable = !outOfDate;
	const change = (transaction: Transaction | undefined) => {
		if (transaction) dispatchAsOneChange(editor, transaction, as.name);
	};
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
		const selecting = selectSlide(editor.state, index);
		if (selecting) editor.view.dispatch(selecting);
		// On a touch screen the keyboard would cover the slide just picked.
		if (!window.matchMedia(COARSE_POINTER).matches) editor.view.focus();
		page.current?.scrollTo({ top: 0 });
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
				<Notice>
					<span className="min-w-0 flex-1">{images.notice}</span>
					<IconButton label="Dismiss" onClick={images.dismiss}>
						<X aria-hidden />
					</IconButton>
				</Notice>
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
					onMove={(from, to) => {
						const before = editor.state.doc;
						change(moveSlideTo(editor.state, from, to));
						select(placeOfMovedSlide(before, editor.state.doc, from, to));
					}}
					onRemove={(index) => change(removeSlide(editor.state, index))}
				/>
				<div ref={page} className="relative min-h-0 min-w-0 flex-1 overflow-y-auto">
					<div className="flex justify-center gap-6 px-8 pt-4 pb-8 max-md:px-4 max-md:pt-1">
						<section
							aria-label="Current slide"
							className="flex w-full min-w-0 max-w-240 flex-col gap-3"
						>
							<div className="flex flex-wrap items-center gap-2">
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
										className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-sm px-2 text-soft-foreground text-xs transition-colors hover:bg-hover data-popup-open:bg-hover max-md:h-11 max-md:text-sm"
									>
										<LayoutTemplate aria-hidden size={16} strokeWidth={1.75} />
										{LAYOUT_NAMES[layoutOf(shown.node)]}
										<ChevronDown aria-hidden size={12} className="text-subtle-foreground" />
									</LayoutPicker>
								)}
								<span className="flex-1" />
								<span className="pr-1 text-subtle-foreground text-xs">
									Slide {current + 1} of {slides.length}
								</span>
							</div>
							<div ref={frame}>
								<LiveDocumentText
									editor={editor}
									ref={text}
									className="min-w-0"
									page={page}
									askBoxOpen={asking !== undefined}
								/>
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
						nestedBlocks={SLIDE_BLOCKS}
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
		</>
	);
}

const COARSE_POINTER = "(pointer: coarse)";

/**
 * The blocks the handle beside a block moves on a slide: those in its frame
 * and in its columns, but not a column itself, which its layout places, nor
 * anything in a list, a quote or a table, which moves with it.
 */
const SLIDE_BLOCKS: NestedOptions = {
	defaultRules: false,
	edgeDetection: "none",
	rules: [
		{
			id: "slideBlocks",
			evaluate: ({ node, parent }) =>
				parent &&
				(parent.type.name === SLIDE_BODY || parent.type.name === SLIDE_COLUMN) &&
				node.type.name !== SLIDE_COLUMN
					? 0
					: EXCLUDED,
		},
	],
};

/** The score that takes a node out of the handle's reach (see the drag handle's rules). */
const EXCLUDED = 1000;

/** How wide the stage must be for the suggestions' cards to sit in a column beside the slide. */
const CARDS_BESIDE_MIN_PAGE_PX = 1000;

/**
 * Draws the text of the slide on the stage, the one starting at `slidePos`,
 * at the largest size at which it fits, as its drawings elsewhere are, each
 * time it changes or the stage changes width. Answers whether it runs over
 * even at the smallest.
 */
function useFittedStage(
	editor: Editor,
	frame: RefObject<HTMLDivElement | null>,
	slidePos: number | undefined,
	slide: unknown,
) {
	const [overflowing, setOverflowing] = useState(false);
	const measure = useCallback(() => {
		const holder = frame.current;
		const drawn = slidePos === undefined ? null : editor.view.nodeDOM(slidePos);
		const body =
			drawn instanceof HTMLElement ? drawn.querySelector(":scope > [data-slide-body]") : null;
		if (!holder || !(body instanceof HTMLElement)) return;
		setOverflowing(fitSlideText(holder, body));
	}, [editor, frame, slidePos]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: measured again whenever the slide changes.
	useLayoutEffect(measure, [measure, slide]);
	useEffect(() => {
		const holder = frame.current;
		if (!holder) return;
		const resized = new ResizeObserver(measure);
		resized.observe(holder);
		holder.addEventListener("load", measure, true);
		return () => {
			resized.disconnect();
			holder.removeEventListener("load", measure, true);
		};
	}, [frame, measure]);
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
 * Adding an image to a slide's empty image column: from the picker that
 * `add` opens with no file, or from a file dropped there. The image is kept
 * for the deck as a Word file's images are kept for a document, then put in
 * the column, wherever others' changes have moved it meanwhile.
 */
function useImageAdding(
	editor: Editor,
	artifact: { podId: string; artifactId: string },
	name: string,
) {
	const [notice, setNotice] = useState<string>();
	const input = useRef<HTMLInputElement>(null);
	const pickingFor = useRef<number>(undefined);
	async function keep(column: number, file: File) {
		setNotice(undefined);
		let at = column;
		const follow = ({
			transaction,
		}: {
			transaction: { mapping: { map: (pos: number) => number } };
		}) => {
			at = transaction.mapping.map(at);
		};
		editor.on("transaction", follow);
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const type = imageTypeOf(bytes);
			if (!type || bytes.byteLength > MAX_ARTIFACT_IMAGE_BYTES) return setNotice(IMAGE_REFUSED);
			const src = await uploadArtifactImage(artifact, { type, bytes });
			const adding = addImage(editor.state, at, { src, alt: file.name.replace(/\.[^.]*$/, "") });
			if (adding) dispatchAsOneChange(editor, adding, name);
		} catch (failure) {
			setNotice(`The image wasn't added. ${failureMessage(failure)}.`);
		} finally {
			editor.off("transaction", follow);
		}
	}
	return {
		notice,
		dismiss: () => setNotice(undefined),
		add: (column: number, file: File | undefined) => {
			if (file) return void keep(column, file);
			pickingFor.current = column;
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
					const column = pickingFor.current;
					if (file && column !== undefined) void keep(column, file);
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
function leftOutInWords({ imagesLeftOut, othersLeftOut }: PowerPointImported): string | undefined {
	const said = [
		...(imagesLeftOut > 0 ? [imagesLeftOutInWords(imagesLeftOut, POWERPOINT_FILE, "deck")] : []),
		...(othersLeftOut > 0 ? [othersLeftOutInWords(othersLeftOut)] : []),
	];
	return said.length > 0 ? said.join(" ") : undefined;
}

function othersLeftOutInWords(count: number): string {
	const which =
		count === 1
			? "1 chart, shape, video or other thing in the PowerPoint file was"
			: `${count} charts, shapes, videos or other things in the PowerPoint file were`;
	return `${which} left out. A deck keeps a slide's text, tables, images and notes.`;
}

const IMAGE_TYPES = "image/png,image/jpeg,image/gif,image/webp";

const IMAGE_REFUSED = `That file isn't an image a deck can show. A deck shows PNG, JPEG, GIF and WebP images of up to ${MAX_ARTIFACT_IMAGE_BYTES / (1024 * 1024)} MB.`;
