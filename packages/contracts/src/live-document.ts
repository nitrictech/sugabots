import { addSuggestionMarks } from "@handlewithcare/prosemirror-suggest-changes";
import { Extension, type Extensions, Mark } from "@tiptap/core";
import { Blockquote } from "@tiptap/extension-blockquote";
import { Document } from "@tiptap/extension-document";
import { BulletList, ListItem, OrderedList } from "@tiptap/extension-list";
import { Fragment, type Node, type Mark as SuggestionMarkOnNode } from "@tiptap/pm/model";
import { StarterKit } from "@tiptap/starter-kit";

/*
 * What a live document holds, for the two places that hold one: the editor in
 * the web app and the API's copy that agents change. They sync node by node,
 * so anything one side's schema lacks is dropped on its way through. Both
 * build their schema from here.
 */

/** Marks content somebody proposes adding, which is not part of the document until it is accepted. */
export const SUGGESTED_INSERTION = "insertion";

/** Marks content somebody proposes removing, which stays part of the document until that is accepted. */
export const SUGGESTED_DELETION = "deletion";

/** Marks a block whose kind or formatting somebody proposes changing. */
const SUGGESTED_MODIFICATION = "modification";

/*
 * The marks are the suggesting library's own, which its commands for making,
 * accepting and reverting a suggestion look up by name. They are declared to
 * the editor as its marks, with the library's rules for how each is drawn and
 * what it excludes.
 */
const suggestionSpecs = addSuggestionMarks({});

type SuggestionMarkName = keyof typeof suggestionSpecs;

const suggestionMark = (name: SuggestionMarkName) =>
	Mark.create({
		name,
		// Typing at its edge is new text of its own, not more of the suggestion.
		inclusive: false,
		excludes: suggestionSpecs[name].excludes,
		addAttributes() {
			return Object.fromEntries(
				Object.keys(suggestionSpecs[name].attrs ?? {}).map((attribute) => [
					attribute,
					{ default: null },
				]),
			);
		},
	});

const SuggestionSchema = Extension.create({
	name: "suggestionSchema",
	extendMarkSchema(extension) {
		const spec = suggestionSpecs[extension.name as SuggestionMarkName];
		return spec ? { toDOM: spec.toDOM, parseDOM: spec.parseDOM } : {};
	},
	addGlobalAttributes() {
		return [
			{
				types: BLOCKS_SUGGESTED_WHOLE,
				attributes: { [BLOCK_SUGGESTION]: { default: null, rendered: false } },
			},
		];
	},
});

/*
 * A suggestion on a whole block is a mark on the block, and the sync layer
 * carries marks on text only. So each block also says what is suggested for
 * it in an attribute, which the sync layer does carry. The two are kept the
 * same: whoever changes the marks writes the attribute (`suggestionsAsAttributes`),
 * and whoever receives the attribute restores the marks from it
 * (`suggestionsFromAttributes`).
 */

/** The attribute a block says its own suggestion marks in, as JSON, or `null` with none. */
export const BLOCK_SUGGESTION = "suggestion";

/** The blocks a suggestion can add, remove or change whole. */
const BLOCKS_SUGGESTED_WHOLE = [
	"paragraph",
	"heading",
	"blockquote",
	"bulletList",
	"orderedList",
	"listItem",
	"codeBlock",
	"horizontalRule",
];

const isSuggestionMark = (mark: SuggestionMarkOnNode) => mark.type.name in suggestionSpecs;

/** What is suggested for the block itself, as its attribute says it: `null` when nothing is. */
export function blockSuggestion(block: Node): string | null {
	const marks = block.marks.filter(isSuggestionMark);
	return marks.length === 0 ? null : JSON.stringify(marks.map((mark) => mark.toJSON()));
}

/** The suggestion marks a block's attribute says it has. */
export function marksOfBlockSuggestion(block: Node): SuggestionMarkOnNode[] {
	const said: unknown = block.attrs[BLOCK_SUGGESTION];
	if (typeof said !== "string") return [];
	return (JSON.parse(said) as unknown[]).map((mark) => block.type.schema.markFromJSON(mark));
}

/** Whether the block is of a kind that says its suggestion in an attribute. */
export const saysBlockSuggestion = (node: Node) => !node.isText && BLOCK_SUGGESTION in node.attrs;

/** The document with every block's attribute saying the suggestion marks the block has, to send. */
export const suggestionsAsAttributes = (document: Node): Node =>
	everyBlock(document, (block, content) =>
		block.type.create(
			{ ...block.attrs, [BLOCK_SUGGESTION]: blockSuggestion(block) },
			content,
			block.marks,
		),
	);

/** The document with every block marked as its attribute says, as received. */
export const suggestionsFromAttributes = (document: Node): Node =>
	everyBlock(document, (block, content) =>
		block.type.create(block.attrs, content, [
			...block.marks.filter((mark) => !isSuggestionMark(mark)),
			...marksOfBlockSuggestion(block),
		]),
	);

/** `node` with `change` made to every block in it that says its suggestion in an attribute. */
function everyBlock(node: Node, change: (block: Node, content: Fragment) => Node): Node {
	if (node.isText) return node;
	const content = Fragment.fromArray(
		node.content.content.map((child) => everyBlock(child, change)),
	);
	return saysBlockSuggestion(node) ? change(node, content) : node.copy(content);
}

/**
 * A block suggested whole, such as a new list item or a paragraph to remove,
 * carries the suggestion's mark itself, which the block holding it must
 * allow. These are the blocks that hold other blocks, each allowing that.
 */
const BLOCK_SUGGESTIONS = {
	marks: [SUGGESTED_INSERTION, SUGGESTED_MODIFICATION, SUGGESTED_DELETION].join(" "),
};
const blocksHoldingBlocks = [Document, Blockquote, BulletList, OrderedList, ListItem].map((node) =>
	node.extend(BLOCK_SUGGESTIONS),
);

/**
 * The editor's standard nodes and marks, but for the blocks declared above in
 * their place. The line that shows where something dragged will land is left
 * to the editor, which draws its own.
 */
const standardKit = {
	document: false,
	blockquote: false,
	bulletList: false,
	orderedList: false,
	listItem: false,
	dropcursor: false,
} as const;

/**
 * The nodes and marks of a live document. The editor passes `undo: false`,
 * because its collaboration extension brings an undo that only takes back the
 * person's own changes.
 */
export const liveDocumentExtensions = ({ undo }: { undo: boolean }): Extensions => [
	StarterKit.configure(undo ? standardKit : { ...standardKit, undoRedo: false }),
	...blocksHoldingBlocks,
	suggestionMark(SUGGESTED_INSERTION),
	suggestionMark(SUGGESTED_DELETION),
	suggestionMark(SUGGESTED_MODIFICATION),
	SuggestionSchema,
];

/** Who made a suggestion: a person in the document, or an agent asked for an edit. */
export interface SuggestionBy {
	kind: "person" | "agent";
	name: string;
}

/**
 * The id of a new suggestion, which every mark of it carries. It says who
 * made it, since the marks have nowhere else to: `unique` first, which holds
 * no colon, then the kind, then the name, which may.
 */
export const suggestionId = (unique: string, by: SuggestionBy): string =>
	`${unique}:${by.kind}:${by.name}`;

/** Who made the suggestion with this id. Nobody known, for an id made elsewhere. */
export function suggestionBy(id: unknown): SuggestionBy {
	const [, kind, ...name] = typeof id === "string" ? id.split(":") : [];
	return kind === "person" || kind === "agent"
		? { kind, name: name.join(":") }
		: { kind: "person", name: "Someone" };
}

/**
 * Which nodes and marks a live document holds, as a number that goes up
 * whenever they change. The sync layer deletes whatever its own schema cannot
 * hold, so a browser tab built for another number, such as one left open
 * across an update, must not join: it would delete what newer tabs wrote.
 */
export const LIVE_DOCUMENT_SCHEMA = 2;

/** The shared type holding the document's content, which the editor's collaboration extension binds to. */
export const LIVE_DOCUMENT_CONTENT = "default";

/**
 * The shared map of the edits people asked a bot for from inside the
 * document, by the id of the thread each request started. A bot working in
 * one of those threads suggests its changes, for the people in the document
 * to accept or reject. Anywhere else, it makes them.
 */
export const LIVE_DOCUMENT_EDIT_REQUESTS = "editRequests";

/** An edit somebody asked a bot for from inside the document. */
export interface EditRequest {
	/** What they asked for, in their words. */
	instruction: string;
	/** The bot they asked, by name. */
	agent: string;
	/** Whether the bot has suggested a change for it yet. */
	answered: boolean;
}
