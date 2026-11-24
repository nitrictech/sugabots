import {
	disableSuggestChanges,
	enableSuggestChanges,
	isSuggestChangesEnabled,
} from "@handlewithcare/prosemirror-suggest-changes";
import { HocuspocusProvider, type onCloseParameters } from "@hocuspocus/provider";
import {
	agentColorSchema,
	agentFaceSchema,
	agentShapeSchema,
	LIVE_EDITOR_REFUSED_CLOSE_CODE,
	type LiveArtifactKind,
	liveEditorQuerySchema,
	MAX_ARTIFACT_IMAGE_BYTES,
} from "@sugabots/contracts";
import {
	LIVE_DOCUMENT_CONTENT,
	LIVE_DOCUMENT_SCHEMA,
	liveDocumentExtensions,
} from "@sugabots/contracts/live-document";
import { Extension, type Extensions } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import { Dropcursor } from "@tiptap/extensions/drop-cursor";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { type Editor, useEditor, useEditorState } from "@tiptap/react";
import { cn } from "cn";
import { Schema } from "effect";
import { Check, ChevronDown, type LucideIcon, Pencil, PenLine, X } from "lucide-react";
import {
	type ComponentProps,
	type CSSProperties,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { Doc } from "yjs";
import { apiBaseUrl } from "@/lib/api-url.ts";
import { artifactImageSource } from "@/lib/artifacts.ts";
import { failureMessage } from "@/lib/failure.ts";
import { ImageNotKept } from "@/lib/file-import.ts";
import { Suggesting, suggestingAs } from "@/lib/suggesting.ts";
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
import type { Range, TextKeys } from "./LiveDocumentBlocks.tsx";

/*
 * What every live editor has, whatever kind of artifact it edits: the
 * connection to the artifact's live copy, the editor on it with everyone
 * else's carets, who else is in it, whether what is typed is saved, and how
 * this person's changes land. A document's editor (`LiveDocument.tsx`) and a
 * deck's (`LiveDeck.tsx`) are each built from these, with what floats over
 * the text (`live-editor-overlays.tsx`).
 */

/** Who the person is to the others in the document. */
export interface Editing {
	name: string;
	email: string;
	image?: string | null;
}

/** What the person calls the artifact being edited, as its notices and menus say it. */
export type EditedNoun = "document" | "deck";

/**
 * The artifact a live editor is on, with its kind, whose schema the editor
 * holds. It is one value so the editor can't hold one kind's schema while
 * connected to an artifact of another, which would delete, for everyone,
 * whatever that schema cannot hold.
 */
export interface LiveArtifact {
	podId: string;
	id: string;
	kind: LiveArtifactKind;
}

/**
 * The connection to an artifact's live document, with the artifact, which
 * the editor on it takes its schema from. `refused` once the API has refused
 * the editor as built for another schema or kind than the artifact's, after
 * which it stays closed.
 */
export interface LiveConnection {
	provider: HocuspocusProvider;
	artifact: LiveArtifact;
	refused: boolean;
}

/**
 * The connection to `artifact`'s live document, for as long as it is on
 * screen. It tells the API the schema and the kind of artifact this editor
 * holds, and stops, rather than trying again, if the API refuses it for
 * holding another than the artifact's.
 */
export function useLiveConnection({ podId, id, kind }: LiveArtifact): LiveConnection | undefined {
	const [connection, setConnection] = useState<LiveConnection>();
	useEffect(() => {
		const artifact = { podId, id, kind };
		const provider = new HocuspocusProvider({
			url: liveDocumentUrl(artifact),
			name: id,
			document: new Doc(),
		});
		provider.on("close", ({ event }: onCloseParameters) => {
			if (event.code !== LIVE_EDITOR_REFUSED_CLOSE_CODE) return;
			provider.disconnect();
			setConnection({ provider, artifact, refused: true });
		});
		setConnection({ provider, artifact, refused: false });
		return () => {
			provider.destroy();
			setConnection(undefined);
		};
	}, [podId, id, kind]);
	return connection;
}

function liveDocumentUrl({ podId, id, kind }: LiveArtifact) {
	const url = new URL(`${apiBaseUrl}/pods/${podId}/artifacts/${id}/live`, window.location.origin);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	// The API lets in only an editor built for the schema the artifact is kept in, and for its kind.
	url.search = new URLSearchParams(
		Schema.encodeSync(liveEditorQuerySchema)({ schema: LIVE_DOCUMENT_SCHEMA, kind }),
	).toString();
	return url.href;
}

/**
 * The editor on the artifact `connection` is to, holding the schema of its
 * kind, with what every live editor holds and `extensions`, what this kind's
 * holds besides. `outOfDate` turns true, and the editor stops editing, when
 * the artifact holds content this editor can't, or the API refused it.
 */
export function useLiveEditor({
	connection,
	title,
	as,
	extensions,
	className,
}: {
	connection: LiveConnection;
	title: string;
	as: Editing;
	extensions: Extensions;
	/** The classes of the editable element. */
	className: string;
}) {
	const { provider, artifact, refused } = connection;
	const slashKeys = useRef<TextKeys>(undefined);
	const [unreadable, setUnreadable] = useState(false);
	const editor = useEditor({
		extensions: [
			...liveDocumentExtensions({
				kind: artifact.kind,
				undo: false,
				// The artifact's own kept images are the only ones it loads.
				ownImages: {
					artifact: { podId: artifact.podId, artifactId: artifact.id },
					source: artifactImageSource,
				},
			}),
			EditTarget,
			...extensions,
			DropLine,
			Suggesting,
			Collaboration.configure({ document: provider.document, field: LIVE_DOCUMENT_CONTENT }),
			CollaborationCaret.configure({
				provider,
				user: { ...as, color: caretColor(as.name) } satisfies Participant,
			}),
		],
		editorProps: {
			attributes: { class: className, "aria-label": title },
			handleKeyDown: (_view, event) => slashKeys.current?.(event) ?? false,
		},
		// Without this the sync layer deletes, for everyone, whatever this editor's schema cannot hold.
		// With it, such content stops this editor instead: it leaves the document and says to reload.
		enableContentCheck: true,
		onContentError: ({ editor: stopped, disableCollaboration }) => {
			disableCollaboration();
			stopped.setEditable(false);
			setUnreadable(true);
		},
	});
	useEffect(() => {
		if (refused) editor?.setEditable(false);
	}, [editor, refused]);
	return { editor, slashKeys, outOfDate: unreadable || refused };
}

/** Shows where a block being dragged will land, as a line the style sheet colours. */
const DropLine = Dropcursor.configure({ color: false, width: 3, class: "drop-line" });

/** Carries the text a request is about, or `null` once the request is sent or dropped. */
export const editTarget = new PluginKey<DecorationSet>("editTarget");

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

/**
 * What goes in the bar above the artifact while it is edited: the faces of
 * everyone else in it and how this person's changes land, in `presenceSlot`,
 * and whether everything typed is saved, in `statusSlot`.
 */
export function EditorBar({
	editor,
	provider,
	as,
	others,
	noun,
	presenceSlot,
	statusSlot,
}: {
	editor: Editor;
	provider: HocuspocusProvider;
	as: Editing;
	others: readonly Other[];
	noun: EditedNoun;
	/** Where the faces of the others are drawn: a place outside the page, such as its title bar. */
	presenceSlot: HTMLElement | null;
	/** Where it says whether everything typed is saved: a place outside the page, such as after its title. */
	statusSlot: HTMLElement | null;
}) {
	const [mode, setMode] = useEditingMode(editor, as);
	const saved = useSaved(provider);
	return (
		<>
			{presenceSlot &&
				createPortal(
					<>
						<Others others={others} />
						<EditingModePicker mode={mode} noun={noun} onChange={setMode} />
					</>,
					presenceSlot,
				)}
			{statusSlot && createPortal(saved ? "Saved" : "Saving", statusSlot)}
		</>
	);
}

/** How a person's own changes land: made at once, or left as suggestions for the others to accept. */
type EditingMode = "editing" | "suggesting";

const EDITING_MODES: Record<
	EditingMode,
	{ label: string; description: (noun: EditedNoun) => string; Icon: LucideIcon }
> = {
	editing: {
		label: "Editing",
		description: (noun) => `Change the ${noun} directly.`,
		Icon: Pencil,
	},
	suggesting: {
		label: "Suggesting",
		description: () => "Your changes wait for someone to accept them.",
		Icon: PenLine,
	},
};

function useEditingMode(editor: Editor, as: Editing) {
	useEffect(() => suggestingAs(editor, as.name), [editor, as.name]);
	const suggesting = useEditorState({
		editor,
		selector: ({ editor: current }) => isSuggestChangesEnabled(current.state),
	});
	const mode: EditingMode = suggesting ? "suggesting" : "editing";
	function setMode(chosen: EditingMode) {
		const change = chosen === "suggesting" ? enableSuggestChanges : disableSuggestChanges;
		change(editor.state, editor.view.dispatch);
		editor.commands.focus();
	}
	return [mode, setMode] as const;
}

/** Chooses how this person's changes land, beside the faces of who else is here. */
function EditingModePicker({
	mode,
	noun,
	onChange,
}: {
	mode: EditingMode;
	noun: EditedNoun;
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
								<span className="text-muted-foreground text-xs">{description(noun)}</span>
							</span>
							<Check aria-hidden className={option === mode ? undefined : "invisible"} />
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

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

/** Something the person should know about the document, in a row across the top of it. */
export function Notice({ children }: { children: ReactNode }) {
	return (
		<div
			role="alert"
			className="flex items-center gap-3 border-border border-b bg-chip px-4 py-2 text-foreground text-xs"
		>
			{children}
		</div>
	);
}

/**
 * Says the editor has stopped, as the artifact holds content this editor
 * can't, or the API refused this editor as built for another, and how to get
 * one that can.
 */
export function OutOfDateNotice({ noun }: { noun: EditedNoun }) {
	return (
		<Notice>
			<span className="min-w-0 flex-1">
				This {noun} has content this tab can't show, so editing here is off. Reload to get the
				latest editor. Nothing in the {noun} was changed.
			</span>
			<Button size="sm" onClick={() => window.location.reload()}>
				Reload
			</Button>
		</Notice>
	);
}

/** Replaces what is being edited with a file's content, for everyone in it. */
export type FileImport = (file: File) => Promise<void>;

/** A kind of file whose content can replace what is edited, as the person is told of it. */
export interface ImportedFileKind {
	/** What the file is called, such as "Word file". */
	name: string;
	/** What the file is when it can be read, such as "a Word document". */
	readAs: string;
}

/**
 * Gives `onImport`, while `editor` is up, how to replace what it edits with
 * a file's content by `importFile`, and `undefined` once it goes. Answers the
 * notice to show at the top of the page: what the last import left out, in
 * the words `importFile` answers, or why the file wasn't imported, until the
 * person dismisses it.
 */
export function useFileImport({
	editor,
	onImport,
	importFile,
	kind,
	noun,
}: {
	editor: Editor | null;
	onImport: (importFile: FileImport | undefined) => void;
	/** Replaces what `editor` edits with the file's content, answering what it left out, in words, when it left out anything. */
	importFile: (editor: Editor, file: File) => Promise<string | undefined>;
	kind: ImportedFileKind;
	noun: EditedNoun;
}): ReactNode {
	const [notice, setNotice] = useState<string>();
	useEffect(() => {
		if (!editor) return;
		onImport(async (file) => {
			setNotice(undefined);
			try {
				setNotice(await importFile(editor, file));
			} catch (failure) {
				setNotice(importFailureInWords(failure, kind, noun));
			}
		});
		return () => onImport(undefined);
	}, [editor, onImport, importFile, kind, noun]);
	if (!notice) return null;
	return (
		<Notice>
			<span className="min-w-0 flex-1">{notice}</span>
			<IconButton label="Dismiss" onClick={() => setNotice(undefined)}>
				<X aria-hidden />
			</IconButton>
		</Notice>
	);
}

/** That an import left out `count` images, and which images what is edited shows, as the person is told it. */
export function imagesLeftOutInWords(
	count: number,
	kind: ImportedFileKind,
	noun: EditedNoun,
): string {
	const which =
		count === 1 ? `1 image in the ${kind.name} was` : `${count} images in the ${kind.name} were`;
	const megabytes = MAX_ARTIFACT_IMAGE_BYTES / BYTES_PER_MEGABYTE;
	return `${which} left out. A ${noun} shows PNG, JPEG, GIF and WebP images of up to ${megabytes} MB, saved inside the file.`;
}

const BYTES_PER_MEGABYTE = 1024 * 1024;

/** Why a file wasn't imported, as the person is told it. */
function importFailureInWords(failure: unknown, kind: ImportedFileKind, noun: EditedNoun): string {
	const why =
		failure instanceof ImageNotKept
			? failureMessage(failure.cause)
			: `It couldn't be read as ${kind.readAs}`;
	return `The ${kind.name} wasn't imported, so the ${noun} is as it was. ${why}.`;
}

/** Everyone else in the document as a row of faces, each ringed in its caret's colour and named on hover. */
function Others({ others }: { others: readonly Other[] }) {
	if (others.length === 0) return null;
	return (
		<ul aria-label="Also here" className="m-0 mr-1 flex list-none items-center p-0">
			{others.map(({ clientId, participant }) => (
				<li key={clientId} className="-ml-1 first:ml-0">
					<Tooltip label={participant.name}>
						<Face participant={participant} size={OTHER_FACE_PX} className="border-2 border-list" />
					</Tooltip>
				</li>
			))}
		</ul>
	);
}

const OTHER_FACE_PX = 22;

/**
 * Someone's face, ringed in their caret's colour and named for assistive
 * technology. It takes a tooltip's trigger props, so it can be one.
 */
export function Face({
	participant,
	size,
	className,
	...props
}: ComponentProps<"span"> & { participant: Participant; size: number }) {
	return (
		<span
			role="img"
			aria-label={participant.name}
			{...props}
			style={{ "--tw-ring-color": participant.color } as CSSProperties}
			// The faces name themselves natively on hover, which would show beside a tooltip.
			className={cn("block rounded-full ring-2 [&>*]:pointer-events-none", className)}
		>
			{participant.agent ? (
				<AgentAvatar {...participant.agent} size={size} />
			) : (
				<PersonAvatar person={{ ...participant, email: participant.email ?? "" }} size={size} />
			)}
		</span>
	);
}

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
export interface Other {
	clientId: number;
	participant: Participant;
	/** The slide they have in front of them, in a deck, as their editor says (see `LiveDeck.tsx`). */
	slide: number | undefined;
}

/** The field of a participant's state in which a deck's editor says which slide they are on. */
export const SLIDE_SHOWN = "slide";

/** Everyone else in the document, bots included. */
export function useOthers(provider: HocuspocusProvider): Other[] {
	const [others, setOthers] = useState<Other[]>([]);
	useEffect(() => {
		const awareness = provider.awareness;
		if (!awareness) return;
		const read = () =>
			setOthers(
				[...awareness.getStates()].flatMap(([clientId, state]) => {
					const participant = Schema.decodeUnknownOption(participantSchema)(state.user);
					const slide: unknown = state[SLIDE_SHOWN];
					return clientId === awareness.clientID || participant._tag === "None"
						? []
						: [
								{
									clientId,
									participant: participant.value,
									slide: typeof slide === "number" ? slide : undefined,
								},
							];
				}),
			);
		read();
		awareness.on("change", read);
		return () => awareness.off("change", read);
	}, [provider]);
	return others;
}

/** A caret colour that stays the same for a name, so a person keeps theirs between visits. */
function caretColor(name: string) {
	let sum = 0;
	for (const character of name) sum += character.charCodeAt(0);
	return CARET_COLORS[sum % CARET_COLORS.length] ?? CARET_COLORS[0];
}

const CARET_COLORS = ["#7c3aed", "#db2777", "#ea580c", "#2563eb", "#059669"] as const;
