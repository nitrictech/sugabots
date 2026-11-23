import { HocuspocusProvider } from "@hocuspocus/provider";
import { agentColorSchema, agentFaceSchema, agentShapeSchema } from "@sugabots/contracts";
import { Collaboration } from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import { type Editor, EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { cn } from "cn";
import { Schema } from "effect";
import {
	Bold,
	Download,
	Heading1,
	Heading2,
	Italic,
	List,
	ListOrdered,
	type LucideIcon,
	Upload,
} from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Doc } from "yjs";
import { apiBaseUrl } from "@/lib/api-url.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

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
	podId,
	artifactId,
	title,
	as,
}: {
	podId: string;
	artifactId: string;
	title: string;
	as: Editing;
}) {
	const provider = useLiveDocument(podId, artifactId);
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-list">
			{provider && (
				<LiveEditor
					key={artifactId}
					provider={provider}
					title={title}
					as={as}
					onDownload={() => downloadAsWord(podId, artifactId)}
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
	title,
	as,
	onDownload,
}: {
	provider: HocuspocusProvider;
	title: string;
	as: Editing;
	onDownload: () => void;
}) {
	const editor = useEditor({
		extensions: [
			// The same nodes the API's copy of the document holds (`artifacts/live.ts` in core).
			// Undo comes from the collaboration extension, which undoes only the person's own changes.
			StarterKit.configure({ undoRedo: false }),
			Collaboration.configure({ document: provider.document }),
			CollaborationCaret.configure({
				provider,
				user: { ...as, color: caretColor(as.name) } satisfies Participant,
			}),
		],
		editorProps: { attributes: { class: "live-document", "aria-label": title } },
	});
	const others = useOthers(provider);
	if (!editor) return null;
	return (
		<>
			<div className="flex items-center gap-1 border-border border-b px-3 py-1.5">
				<FormatButton editor={editor} label="Bold" Icon={Bold} mark="bold" />
				<FormatButton editor={editor} label="Italic" Icon={Italic} mark="italic" />
				<FormatButton editor={editor} label="Heading" Icon={Heading1} node="heading" level={1} />
				<FormatButton editor={editor} label="Subheading" Icon={Heading2} node="heading" level={2} />
				<FormatButton editor={editor} label="Bulleted list" Icon={List} node="bulletList" />
				<FormatButton editor={editor} label="Numbered list" Icon={ListOrdered} node="orderedList" />
				<span className="flex-1" />
				<Others others={others} />
				<OpenWordFile editor={editor} />
				<IconButton label="Download as Word" onClick={onDownload}>
					<Download aria-hidden />
				</IconButton>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<article className="mx-auto max-w-190 px-6 py-6 max-md:px-4">
					<EditorContent editor={editor} />
				</article>
			</div>
		</>
	);
}

/** A formatting control, lit while the caret is in what it makes. */
function FormatButton({
	editor,
	label,
	Icon,
	...format
}: {
	editor: Editor;
	label: string;
	Icon: LucideIcon;
} & (
	| { mark: "bold" | "italic" }
	| { node: "bulletList" | "orderedList" }
	| { node: "heading"; level: 1 | 2 }
)) {
	const active = useEditorState({
		editor,
		selector: ({ editor: current }) =>
			"mark" in format
				? current.isActive(format.mark)
				: current.isActive(format.node, "level" in format ? { level: format.level } : undefined),
	});
	function toggle() {
		const chain = editor.chain().focus();
		if ("mark" in format)
			return (format.mark === "bold" ? chain.toggleBold() : chain.toggleItalic()).run();
		if (format.node === "heading") return chain.toggleHeading({ level: format.level }).run();
		return (
			format.node === "bulletList" ? chain.toggleBulletList() : chain.toggleOrderedList()
		).run();
	}
	return (
		<IconButton
			label={label}
			aria-pressed={active}
			onClick={toggle}
			className={cn(active && "bg-hover-strong text-foreground")}
		>
			<Icon aria-hidden />
		</IconButton>
	);
}

/** Replaces the document with a Word file's content, for everyone in it. */
function OpenWordFile({ editor }: { editor: Editor }) {
	const input = useRef<HTMLInputElement>(null);
	async function open(file: File | undefined) {
		if (!file) return;
		const { convertToHtml } = await import("mammoth");
		const { value } = await convertToHtml({ arrayBuffer: await file.arrayBuffer() });
		editor.commands.setContent(value);
	}
	return (
		<>
			<input
				ref={input}
				type="file"
				accept=".docx"
				hidden
				onChange={(event) => {
					void open(event.target.files?.[0]);
					event.target.value = "";
				}}
			/>
			<IconButton label="Replace with a Word file" onClick={() => input.current?.click()}>
				<Upload aria-hidden />
			</IconButton>
		</>
	);
}

/**
 * Saves the document as a .docx. The API builds the file from its own copy,
 * which holds what everyone has typed.
 */
function downloadAsWord(podId: string, artifactId: string) {
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
	return url.href;
}

/** A caret colour that stays the same for a name, so a person keeps theirs between visits. */
function caretColor(name: string) {
	let sum = 0;
	for (const character of name) sum += character.charCodeAt(0);
	return CARET_COLORS[sum % CARET_COLORS.length] ?? CARET_COLORS[0];
}

const CARET_COLORS = ["#7c3aed", "#db2777", "#ea580c", "#2563eb", "#059669"] as const;
