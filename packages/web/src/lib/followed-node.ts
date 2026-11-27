import type { Node } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { type ProsemirrorBinding, ySyncPluginKey } from "@tiptap/y-tiptap";
import { XmlElement, XmlFragment } from "yjs";

/*
 * A node of a live document's editor, found again after anybody's changes by
 * the element the shared document keeps it as, for as long as it is there.
 *
 * A position alone follows only the changes made here, step by step. The sync
 * layer makes a change from somebody else, or an undo or redo, by replacing
 * each of the document's top-level nodes the change touches whole, from that
 * node's start, so mapping a position through it says a node in one of them,
 * or one of them itself, was deleted, though it is still there. A position in
 * the shared document is no better: one at a deleted element reads as the
 * place the element was, not as gone.
 *
 * A node can be followed when it, and each node holding it, sits among nodes
 * alone, not text, as a deck's slides and boxes do: the shared document holds
 * those child for child.
 */

/** A node being followed (see `followNode`). */
export interface FollowedNode {
	readonly element: XmlElement;
	readonly binding: ProsemirrorBinding;
}

/**
 * The node starting at `pos` in `state`, to follow from now on. `undefined`
 * when the editor's document isn't shared, or nothing in the shared document
 * stands for a node starting there, as for text.
 */
export function followNode(state: EditorState, pos: number): FollowedNode | undefined {
	const binding = ySyncPluginKey.getState(state)?.binding;
	const node = state.doc.nodeAt(pos);
	if (!binding || !node) return undefined;
	const place = state.doc.resolve(pos);
	let holder: XmlFragment = binding.type;
	for (let depth = 0; depth <= place.depth; depth++) {
		const child = holder.get(place.index(depth));
		if (!(child instanceof XmlElement)) return undefined;
		holder = child;
	}
	return holder instanceof XmlElement && standsFor(binding.mapping.get(holder), node)
		? { element: holder, binding }
		: undefined;
}

/**
 * Where the node `followed` starts in `doc`, the editor's document, or
 * `undefined` once it is gone. A change made here reaches the shared document
 * only once the editor is updated with it: until then, a node that change
 * touches may not be found, but no node is ever found anywhere it isn't.
 */
export function whereFollowedNodeIs(doc: Node, followed: FollowedNode): number | undefined {
	const { element, binding } = followed;
	const node = binding.mapping.get(element);
	const places = placesOf(element, binding.type);
	if (!node || !places) return undefined;
	let holder = doc;
	let start = 0;
	let contentStart = 0;
	for (const place of places) {
		if (place >= holder.childCount) return undefined;
		start = contentStart;
		for (let before = 0; before < place; before++) start += holder.child(before).nodeSize;
		holder = holder.child(place);
		contentStart = start + 1;
	}
	return standsFor(node, holder) ? start : undefined;
}

/**
 * Whether `known`, the node the sync layer knows an element of the shared
 * document by, is `node`. It is too when the two differ only by the marks on
 * nodes in them, which the sync layer leaves out of the shared document: the
 * suggestion marks restored on a node after a change from elsewhere (see
 * `lib/suggesting.ts`) make it a new node, which the sync layer never learns
 * of, and goes on knowing its element by the node as it was before.
 */
function standsFor(known: Node | readonly Node[] | undefined, node: Node): boolean {
	if (known === node) return true;
	return known !== undefined && !isNodeList(known) && sameButForNodeMarks(known, node);
}

/** Whether what the sync layer knows an element by is a list of nodes, as it knows a run of text. */
const isNodeList = (known: Node | readonly Node[]): known is readonly Node[] =>
	Array.isArray(known);

/** Whether `one` and `other` hold the same, and are the same kind with the same attributes, whatever marks are on either, or on any node, not text, in them. */
function sameButForNodeMarks(one: Node, other: Node): boolean {
	if (one === other) return true;
	if (one.isText || other.isText) return one.eq(other);
	if (!one.hasMarkup(other.type, other.attrs, one.marks) || one.childCount !== other.childCount) {
		return false;
	}
	for (let index = 0; index < one.childCount; index++) {
		if (!sameButForNodeMarks(one.child(index), other.child(index))) return false;
	}
	return true;
}

/** A key for the node `followed` alone, the same each time it is followed, for React to know it by. */
export function keyOfFollowedNode({ element }: FollowedNode): string {
	const known = keys.get(element);
	if (known !== undefined) return known;
	keysGiven += 1;
	const key = String(keysGiven);
	keys.set(element, key);
	return key;
}

const keys = new WeakMap<XmlElement, string>();
let keysGiven = 0;

/**
 * The place of `element` among its siblings, and of each element holding it
 * among theirs, from the top of `root` down to it: `undefined` once it or any
 * of them is deleted.
 */
function placesOf(element: XmlElement, root: XmlFragment): number[] | undefined {
	const places: number[] = [];
	for (let child = element; ; ) {
		const parent = child.parent;
		if (!(parent instanceof XmlFragment)) return undefined;
		const place = parent.toArray().indexOf(child);
		if (place < 0) return undefined;
		places.unshift(place);
		if (parent === root) return places;
		if (!(parent instanceof XmlElement)) return undefined;
		child = parent;
	}
}
