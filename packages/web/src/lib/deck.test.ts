import {
	disableSuggestChanges,
	enableSuggestChanges,
} from "@handlewithcare/prosemirror-suggest-changes";
import {
	liveDocumentExtensions,
	SUGGESTED_DELETION,
	SUGGESTED_INSERTION,
	suggestionBy,
} from "@sugabots/contracts/live-document";
import { liveDocumentFromMarkdown } from "@sugabots/contracts/live-document-markdown";
import {
	bodyOf,
	FIRST_BOX_IN_SLIDE,
	fitSlideBody,
	isMarkedRemoved,
	isOffItsSlide,
	layoutOf,
	PLACEMENT,
	placementOf,
	SLIDE_BODY,
	SLIDE_BOX,
} from "@sugabots/contracts/live-slides";
import type { Frame } from "@sugabots/contracts/slides-markdown";
import { Editor, Extension } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import type { Node } from "@tiptap/pm/model";
import { type EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { afterEach, describe, expect, it } from "vitest";
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from "yjs";
import { deckStage } from "@/screens/deck-stage.ts";
import {
	addSlide,
	BOX_REMOVAL_BLOCKED_WORDS,
	type BoxIndex,
	boxRemovalBlocked,
	changeLayout,
	keepSlidesFitting,
	moveSlideTo,
	placeBox,
	placeOfMovedSlide,
	proposedChangeOf,
	removeBox,
	removeSlide,
	resetLayout,
	type SlideIndex,
	type SlidePos,
	slideIndexAt,
	slidesOf,
} from "./deck.ts";
import { dispatchAsOneChange, Suggesting, suggestingAs } from "./suggesting.ts";
import { pendingSuggestions, settlingSuggestion } from "./suggestions.ts";

const editors: Editor[] = [];
afterEach(() => {
	for (const editor of editors.splice(0)) editor.destroy();
});

const GOALS = "<!-- layout: bullets -->\n\n## Goals\n\n- Ship on Friday\n- Tell support first";
const PEOPLE =
	"<!-- layout: columns -->\n\n## People and bots\n\n<!-- box -->\n\n- People type\n\n<!-- box -->\n\n- Bots suggest";
const DECK = [GOALS, PEOPLE].join("\n\n---\n\n");

const KeepsSlidesFitting = Extension.create({
	name: "keepsSlidesFitting",
	addProseMirrorPlugins: () => [keepSlidesFitting],
});

/**
 * Two people in one live deck, `deck` in Markdown, each in their own editor,
 * with what either does reaching the other, but for what they do `apart`.
 * Kim's editor keeps the slides fitting unless `kimFits` is false, as an
 * editor of an older version wouldn't; Sam's always does. With `onStage`,
 * each edits the deck on the stage the app shows it on, which fits its slides
 * too.
 */
function twoPeople({
	kimFits = true,
	deck = DECK,
	onStage = false,
}: {
	kimFits?: boolean;
	deck?: string;
	onStage?: boolean;
} = {}) {
	const [kims, sams] = [new Doc(), new Doc()];
	let inTouch = true;
	kims.on("update", (update, origin) => {
		if (inTouch && origin !== "sync") applyUpdate(sams, update, "sync");
	});
	sams.on("update", (update, origin) => {
		if (inTouch && origin !== "sync") applyUpdate(kims, update, "sync");
	});
	const editorOf = (document: Doc, name: string, fits: boolean) => {
		const fitting = onStage
			? [deckStage({ onUnderSlide: () => {}, onAddImage: () => {} })]
			: fits
				? [KeepsSlidesFitting]
				: [];
		const editor = new Editor({
			element: window.document.createElement("div"),
			extensions: [
				...liveDocumentExtensions({ kind: "slides", undo: false }),
				Suggesting,
				...fitting,
				Collaboration.configure({ document }),
			],
		});
		suggestingAs(editor, name);
		editors.push(editor);
		return editor;
	};
	const [kim, sam] = [editorOf(kims, "Kim", kimFits), editorOf(sams, "Sam", true)];
	kim.commands.setContent(liveDocumentFromMarkdown("slides", deck).toJSON());
	/**
	 * Runs `meanwhile` with Kim's and Sam's editors out of touch, so neither
	 * has what the other does until it ends, as when both change the deck at
	 * once; then brings each what the other did.
	 */
	const apart = (meanwhile: () => void) => {
		inTouch = false;
		meanwhile();
		inTouch = true;
		applyUpdate(sams, encodeStateAsUpdate(kims, encodeStateVector(sams)), "sync");
		applyUpdate(kims, encodeStateAsUpdate(sams, encodeStateVector(kims)), "sync");
	};
	return { kim, sam, apart };
}

/** `index` as a slide's index, for a slide the test's deck has there, or for a place it has none, as a stale index would be. */
const slideIndex = (index: number) => index as SlideIndex;

/** The slides, by number from 1, whose body doesn't hold what their layout says. */
const unfitted = (deck: Node) =>
	deck.children.flatMap((slide, index) => {
		const body = bodyOf(slide);
		return fitSlideBody(body, layoutOf(slide)).eq(body) ? [] : [index + 1];
	});

/** What each slide's body holds: each box, by the names of its blocks, and its words. */
const boxContentsOf = (deck: Node) =>
	deck.children.map((slide) =>
		bodyOf(slide).children.map(
			(box) => `${box.children.map((block) => block.type.name).join(" ")}: ${box.textContent}`,
		),
	);

/** The words on each slide, in order, whatever holds them. */
const wordsOf = (deck: Node) => deck.children.map((slide) => bodyOf(slide).textContent);

const LAUNCH = "<!-- layout: bullets -->\n\n## Launch\n\n- Brief sales\n- Book the room";
const THANKS = "<!-- layout: title -->\n\n## Thanks";
const FOUR = [GOALS, PEOPLE, LAUNCH, THANKS].join("\n\n---\n\n");

/** The title of each slide, in order: the words of its first box. */
const titlesOf = (deck: Node) => deck.children.map((slide) => bodyOf(slide).child(0).textContent);

/** Where the first box of the slide at `index` starts. */
const firstBoxStart = (deck: Node, index: number) =>
	(slidesOf(deck)[index]?.pos ?? 0) + FIRST_BOX_IN_SLIDE;

/** Where the box at `box` of the slide at `slide` starts, and that box. */
function nthBox(deck: Node, slide: number, box: number) {
	const body = bodyOf(deck.child(slide));
	let at = firstBoxStart(deck, slide);
	for (let index = 0; index < box; index++) at += body.child(index).nodeSize;
	return { at, node: body.child(box) };
}

/** Where the slide at `index`'s title starts: in its first box's first line. */
const titleStart = (deck: Node, index: number) => nthBox(deck, index, 0).at + 2;

/** Where the slide at `index`'s title ends: at the end of its first box's first line. */
const titleEnd = (deck: Node, index: number) => {
	const title = nthBox(deck, index, 0);
	return title.at + (title.node.firstChild?.nodeSize ?? 0);
};

/** Ends the change being recorded for undo, as a moment's pause between two changes does. */
const pause = (editor: Editor) =>
	yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();

/** `index` as a box's index, for a box the slide has there. */
const boxIndex = (index: number) => index as BoxIndex;

/** Where the slide at `index` of `deck` starts, which it must have. */
function slideStart(deck: Node, index: number): SlidePos {
	const slide = slidesOf(deck)[index];
	if (!slide) throw new Error(`No slide ${index}`);
	return slide.pos;
}

/** Makes `change`, which there must be, in `editor`, as the app makes a change to a slide's boxes. */
function make(editor: Editor, change: (state: EditorState) => Transaction | undefined) {
	const changing = change(editor.state);
	if (!changing) throw new Error("No change");
	editor.view.dispatch(changing);
}

/** Whether each box of the slide at `index` is off it. */
const offSlide = (deck: Node, index: number) =>
	bodyOf(deck.child(index)).children.map(isOffItsSlide);

describe("a deck's slides, kept fitting their layouts", () => {
	it("lays a slide out again after a change here leaves two of its boxes as one, losing nothing", () => {
		const { kim, sam } = twoPeople();
		const people = bodyOf(kim.state.doc.child(1));
		const [left, right] = [nthBox(kim.state.doc, 1, 1), nthBox(kim.state.doc, 1, 2)];
		const joined = kim.schema.nodes[SLIDE_BOX]?.create(null, [
			...left.node.content.content,
			...right.node.content.content,
		]);
		if (!joined) throw new Error("No box node");

		kim.view.dispatch(kim.state.tr.replaceWith(left.at, right.at + right.node.nodeSize, joined));

		expect(unfitted(kim.state.doc)).toEqual([]);
		expect(boxContentsOf(kim.state.doc)[1]).toEqual([
			"heading: People and bots",
			"bulletList bulletList: People typeBots suggest",
			"paragraph: ",
		]);
		// The others get it fitted, as it was made.
		expect(boxContentsOf(sam.state.doc)).toEqual(boxContentsOf(kim.state.doc));
		expect(people.textContent).toBe(bodyOf(kim.state.doc.child(1)).textContent);
	});

	it("brings a box pasted into a slide whose layout has no place for it into its last box, losing nothing", () => {
		const { kim } = twoPeople();
		const list = nthBox(kim.state.doc, 0, 1);
		const pasted = kim.schema.nodes[SLIDE_BOX]?.create(null, [
			kim.schema.node("paragraph", null, [kim.schema.text("Pasted words")]),
		]);
		if (!pasted) throw new Error("No box node");

		kim.view.dispatch(kim.state.tr.insert(list.at + list.node.nodeSize, pasted));

		expect(unfitted(kim.state.doc)).toEqual([]);
		expect(boxContentsOf(kim.state.doc)[0]).toEqual([
			"heading: Goals",
			"bulletList paragraph: Ship on FridayTell support firstPasted words",
		]);
	});

	it("leaves what arrives from somebody else as it arrives, rather than fight it", () => {
		const { kim, sam } = twoPeople({ kimFits: false });
		const right = nthBox(kim.state.doc, 1, 2);

		kim.view.dispatch(kim.state.tr.delete(right.at, right.at + right.node.nodeSize));

		expect(unfitted(sam.state.doc)).toEqual([2]);
		expect(boxContentsOf(sam.state.doc)).toEqual(boxContentsOf(kim.state.doc));
	});

	it("leaves a slide with a suggestion waiting in it as it is, until the suggestion is settled", () => {
		const { kim } = twoPeople();
		enableSuggestChanges(kim.state, kim.view.dispatch);
		kim.view.dispatch(kim.state.tr.insertText(" for launch", titleEnd(kim.state.doc, 0)));
		disableSuggestChanges(kim.state, kim.view.dispatch);
		const extra = kim.schema.nodes[SLIDE_BOX]?.create(null, [
			kim.schema.node("paragraph", null, [kim.schema.text("A box too many")]),
		]);
		if (!extra) throw new Error("No box node");

		kim.view.dispatch(kim.state.tr.insert(firstBoxStart(kim.state.doc, 0), extra));

		expect(unfitted(kim.state.doc)).toEqual([1]);
		const [suggestion] = pendingSuggestions(kim.state.doc);
		if (!suggestion) throw new Error("No suggestion");
		settlingSuggestion(suggestion.id, "accept")(kim.state, kim.view.dispatch);
		expect(unfitted(kim.state.doc)).toEqual([]);
		expect(wordsOf(kim.state.doc)[0]).toBe(
			"A box too manyGoals for launchShip on FridayTell support first",
		);
	});
});

describe("a slide's layout, changed", () => {
	it("is suggested as the API suggests it: the new layout on the slide, and the box it lacks to add", () => {
		const { kim, sam } = twoPeople();
		enableSuggestChanges(kim.state, kim.view.dispatch);

		const change = changeLayout(kim.state, slideIndex(0), "columns");
		if (!change) throw new Error("No change");
		dispatchAsOneChange(kim, change, "Kim");

		const goals = sam.state.doc.child(0);
		expect(goals.attrs.layout).toBe("columns");
		expect(goals.marks.map((mark) => mark.attrs)).toMatchObject([
			{ type: "attr", attrName: "layout", previousValue: "bullets", newValue: "columns" },
		]);
		expect(
			bodyOf(goals).children.map((box) => [
				box.textContent,
				box.marks.map((mark) => mark.type.name),
			]),
		).toEqual([
			["Goals", []],
			["Ship on FridayTell support first", []],
			["", ["insertion"]],
		]);
		// One suggestion, which says what it does.
		expect(pendingSuggestions(sam.state.doc)).toMatchObject([
			{ by: { kind: "person", name: "Kim" }, slides: { layout: "columns" } },
		]);
	});

	it.each([
		["accepted", "accept", "columns"],
		["undone", "reject", "bullets"],
	] as const)(
		"keeps every word once the suggestion is %s, the slide fitting its layout",
		(_, how, layout) => {
			const { kim, sam } = twoPeople();
			enableSuggestChanges(kim.state, kim.view.dispatch);
			const change = changeLayout(kim.state, slideIndex(0), "columns");
			if (!change) throw new Error("No change");
			dispatchAsOneChange(kim, change, "Kim");
			const [suggestion] = pendingSuggestions(sam.state.doc);
			if (!suggestion) throw new Error("No suggestion");

			settlingSuggestion(suggestion.id, how)(sam.state, sam.view.dispatch);

			for (const deck of [sam.state.doc, kim.state.doc]) {
				expect(pendingSuggestions(deck)).toEqual([]);
				expect(deck.child(0).attrs.layout).toBe(layout);
				expect(unfitted(deck)).toEqual([]);
				expect(wordsOf(deck)[0]).toBe("GoalsShip on FridayTell support first");
			}
		},
	);

	it("undoes a suggested layout that moves nothing, which only changes the slide's layout", () => {
		const { kim, sam } = twoPeople();
		enableSuggestChanges(kim.state, kim.view.dispatch);
		const change = changeLayout(kim.state, slideIndex(1), "image");
		if (!change) throw new Error("No change");
		dispatchAsOneChange(kim, change, "Kim");
		expect(sam.state.doc.child(1).attrs.layout).toBe("image");
		const [suggestion] = pendingSuggestions(sam.state.doc);
		if (!suggestion) throw new Error("No suggestion");

		settlingSuggestion(suggestion.id, "reject")(sam.state, sam.view.dispatch);

		expect(kim.state.doc.child(1).attrs.layout).toBe("columns");
		expect(pendingSuggestions(kim.state.doc)).toEqual([]);
	});

	it("is made at once while editing, moving only what moves", () => {
		const { kim, sam } = twoPeople();
		const title = bodyOf(kim.state.doc.child(1)).child(0);

		const change = changeLayout(kim.state, slideIndex(1), "bullets");
		if (!change) throw new Error("No change");
		dispatchAsOneChange(kim, change, "Kim");

		expect(boxContentsOf(sam.state.doc)[1]).toEqual([
			"heading: People and bots",
			"bulletList bulletList: People typeBots suggest",
		]);
		// The title stays the node it was, so someone typing in it keeps what they type.
		expect(bodyOf(kim.state.doc.child(1)).child(0)).toBe(title);
	});

	it("is refused while a suggestion waits in the slide", () => {
		const { kim } = twoPeople();
		enableSuggestChanges(kim.state, kim.view.dispatch);
		kim.view.dispatch(kim.state.tr.insertText(" for launch", titleEnd(kim.state.doc, 0)));

		expect(changeLayout(kim.state, slideIndex(0), "quote")).toBeUndefined();
	});
});

describe("a placed slide's layout, changed", () => {
	const PLACED_GOALS = [
		{ x: 80, y: 64, width: 800, height: 46 },
		{ x: 80, y: 142, width: 440, height: 300 },
	];

	/** Kim and Sam in the deck, Kim having placed the goals' boxes by hand. */
	function placedGoals() {
		const people = twoPeople();
		const { kim } = people;
		const goals = slidesOf(kim.state.doc)[0];
		if (!goals) throw new Error("No slide");
		kim.view.dispatch(kim.state.tr.setNodeAttribute(goals.pos, PLACEMENT, PLACED_GOALS));
		return people;
	}

	it.each([
		["columns", "with a box more"],
		["quote", "with as many boxes"],
	] as const)("to %s, %s, is laid out by it, its boxes no longer placed", (layout, _) => {
		const { kim, sam } = placedGoals();
		expect(placementOf(sam.state.doc.child(0))).toEqual(PLACED_GOALS);

		const change = changeLayout(kim.state, slideIndex(0), layout);
		if (!change) throw new Error("No change");
		dispatchAsOneChange(kim, change, "Kim");

		expect(sam.state.doc.child(0).attrs.layout).toBe(layout);
		expect(sam.state.doc.child(0).attrs[PLACEMENT]).toBeNull();
	});

	it.each([
		["accepted", "accept", "columns", null],
		["undone", "reject", "bullets", PLACED_GOALS],
	] as const)(
		"as a suggestion %s, leaves the slide laid out as it then is",
		(_, how, layout, placement) => {
			const { kim, sam } = placedGoals();
			enableSuggestChanges(kim.state, kim.view.dispatch);
			const change = changeLayout(kim.state, slideIndex(0), "columns");
			if (!change) throw new Error("No change");
			dispatchAsOneChange(kim, change, "Kim");
			// One suggestion, of the new layout, which takes the placement with it.
			const [suggestion, ...more] = pendingSuggestions(sam.state.doc);
			if (!suggestion) throw new Error("No suggestion");
			expect(more).toEqual([]);
			expect(suggestion.slides).toMatchObject({ layout: "columns" });

			settlingSuggestion(suggestion.id, how)(sam.state, sam.view.dispatch);

			for (const deck of [sam.state.doc, kim.state.doc]) {
				expect(deck.child(0).attrs.layout).toBe(layout);
				expect(placementOf(deck.child(0))).toEqual(placement);
				expect(unfitted(deck)).toEqual([]);
			}
		},
	);
});

/** Where the goals slide's layout draws its boxes, as the stage measures them. */
const DRAWN_GOALS: Frame[] = [
	{ x: 80, y: 64, width: 800, height: 46 },
	{ x: 80, y: 142, width: 800, height: 334 },
];
/** The goals' list moved down. */
const MOVED_LIST: Frame = { x: 80, y: 200, width: 800, height: 334 };
/** The goals' title made narrower and taller. */
const RESIZED_TITLE: Frame = { x: 80, y: 64, width: 400, height: 60 };

describe("a slide's boxes, placed by hand", () => {
	it("are all placed by the first move of one, the others where its layout drew them, and only the box moved after that", () => {
		const { kim, sam } = twoPeople();

		make(kim, (state) =>
			placeBox(state, slideStart(state.doc, 0), boxIndex(1), MOVED_LIST, DRAWN_GOALS),
		);

		expect(placementOf(sam.state.doc.child(0))).toEqual([DRAWN_GOALS[0], MOVED_LIST]);

		// What the stage measures no longer matters once the slide is placed.
		make(kim, (state) =>
			placeBox(state, slideStart(state.doc, 0), boxIndex(0), RESIZED_TITLE, [
				MOVED_LIST,
				MOVED_LIST,
			]),
		);

		expect(placementOf(sam.state.doc.child(0))).toEqual([RESIZED_TITLE, MOVED_LIST]);
	});

	it.each([
		["moved", 1, MOVED_LIST],
		["resized", 0, RESIZED_TITLE],
	] as const)(
		"are %s at once, never as a suggestion, even while the person is suggesting",
		(_, box, frame) => {
			const { kim, sam } = twoPeople();
			enableSuggestChanges(kim.state, kim.view.dispatch);

			make(kim, (state) =>
				placeBox(state, slideStart(state.doc, 0), boxIndex(box), frame, DRAWN_GOALS),
			);

			expect(placementOf(sam.state.doc.child(0))?.[box]).toEqual(frame);
			expect(pendingSuggestions(sam.state.doc)).toEqual([]);
		},
	);

	it.each([
		["editing", false],
		["suggesting, never as a suggestion", true],
	] as const)(
		"are left to the slide's layout again by resetting it while %s, its deleted boxes back on it with the line they were left with",
		(_, suggests) => {
			const { kim, sam } = twoPeople();
			make(kim, (state) =>
				placeBox(state, slideStart(state.doc, 0), boxIndex(1), MOVED_LIST, DRAWN_GOALS),
			);
			make(kim, (state) => removeBox(state, slideStart(state.doc, 0), boxIndex(0)));
			expect(offSlide(sam.state.doc, 0)).toEqual([true, false]);
			if (suggests) enableSuggestChanges(kim.state, kim.view.dispatch);

			make(kim, (state) => resetLayout(state, slideIndex(0)));

			for (const deck of [sam.state.doc, kim.state.doc]) {
				expect(placementOf(deck.child(0))).toBeNull();
				expect(bodyOf(deck.child(0)).children.map(isMarkedRemoved)).toEqual([false, false]);
				expect(boxContentsOf(deck)[0]).toEqual([
					"heading: ",
					"bulletList: Ship on FridayTell support first",
				]);
			}
			expect(pendingSuggestions(sam.state.doc)).toEqual([]);
		},
	);
});

describe("a box deleted from its slide", () => {
	it("can't be deleted while the person is suggesting, which they are told to turn off", () => {
		const { kim } = twoPeople();
		enableSuggestChanges(kim.state, kim.view.dispatch);

		expect(removeBox(kim.state, slideStart(kim.state.doc, 0), boxIndex(1))).toBeUndefined();
		const blocked = boxRemovalBlocked(kim.state, nthBox(kim.state.doc, 0, 1).node);
		expect(blocked && BOX_REMOVAL_BLOCKED_WORDS[blocked]).toBe(
			"Turn off Suggesting to delete a box.",
		);
		expect(offSlide(kim.state.doc, 0)).toEqual([false, false]);
	});

	it("can't be deleted while it holds a suggestion, which the person is told to settle, though a box beside it can", () => {
		const { kim, sam } = twoPeople();
		enableSuggestChanges(sam.state, sam.view.dispatch);
		// At the start of the list's first line: past the box's, the list's and the item's starts.
		sam.view.dispatch(sam.state.tr.insertText("Soon: ", nthBox(sam.state.doc, 0, 1).at + 4));

		expect(removeBox(kim.state, slideStart(kim.state.doc, 0), boxIndex(1))).toBeUndefined();
		const blocked = boxRemovalBlocked(kim.state, nthBox(kim.state.doc, 0, 1).node);
		expect(blocked && BOX_REMOVAL_BLOCKED_WORDS[blocked]).toBe(
			"Accept or undo the suggestions in this box to delete it.",
		);
		expect(removeBox(kim.state, slideStart(kim.state.doc, 0), boxIndex(0))).toBeDefined();
	});

	it("is back, holding what it held, after one undo, which leaves the edit made before it", () => {
		const { kim, sam } = twoPeople({ deck: FOUR });
		pause(kim);
		kim.view.dispatch(kim.state.tr.insertText("Our ", titleStart(kim.state.doc, 3)));
		pause(kim);
		const edited = sam.state.doc.toJSON();
		make(kim, (state) => removeBox(state, slideStart(state.doc, 0), boxIndex(1)));
		pause(kim);
		expect(boxContentsOf(sam.state.doc)[0]).toEqual(["heading: Goals", "paragraph: "]);
		expect(offSlide(sam.state.doc, 0)).toEqual([false, true]);

		kim.commands.undo();

		expect(sam.state.doc.toJSON()).toEqual(edited);
		expect(kim.state.doc.toJSON()).toEqual(edited);
	});

	/** Kim and Sam in the deck, Kim having deleted the goals' title and then given them two columns, suggesting if `suggests`. */
	function inColumnsAfterDeletingTitle(suggests: boolean) {
		const people = twoPeople();
		const { kim } = people;
		make(kim, (state) => removeBox(state, slideStart(state.doc, 0), boxIndex(0)));
		if (suggests) enableSuggestChanges(kim.state, kim.view.dispatch);
		const change = changeLayout(kim.state, slideIndex(0), "columns");
		if (!change) throw new Error("No change");
		dispatchAsOneChange(kim, change, "Kim");
		return people;
	}

	it("is back on its slide once the slide is given a new layout", () => {
		const { kim, sam } = inColumnsAfterDeletingTitle(false);

		for (const deck of [sam.state.doc, kim.state.doc]) {
			expect(layoutOf(deck.child(0))).toBe("columns");
			expect(offSlide(deck, 0)).toEqual([false, false, false]);
		}
	});

	it.each([
		["accepted, back on it", "accept", "columns", [false, false, false]],
		["undone, still off it", "reject", "bullets", [true, false]],
	] as const)(
		"follows a new layout suggested for its slide once that is %s",
		(_, how, layout, off) => {
			const { kim, sam } = inColumnsAfterDeletingTitle(true);
			const [suggestion, ...more] = pendingSuggestions(sam.state.doc);
			if (!suggestion) throw new Error("No suggestion");
			expect(more).toEqual([]);

			settlingSuggestion(suggestion.id, how)(sam.state, sam.view.dispatch);

			for (const deck of [sam.state.doc, kim.state.doc]) {
				expect(layoutOf(deck.child(0))).toBe(layout);
				expect(offSlide(deck, 0)).toEqual(off);
				expect(unfitted(deck)).toEqual([]);
			}
		},
	);
});

describe("the caret on the stage, kept out of a box deleted from its slide", () => {
	/** Puts `editor`'s caret at the start of the box at `box` of the slide at `slide`. */
	function caretIn(editor: Editor, slide: number, box: number) {
		const { at } = nthBox(editor.state.doc, slide, box);
		editor.view.dispatch(
			editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(at + 1))),
		);
	}

	/**
	 * The places of the slide and of the box the caret is in, and whether that
	 * box is off its slide. The box is `undefined` outside the slide's boxes,
	 * as in its notes.
	 */
	function whereCaretIs(editor: Editor) {
		const { $from } = editor.state.selection;
		const inBox = $from.depth >= 3 && $from.node(2).type.name === SLIDE_BODY;
		return {
			slide: $from.index(0),
			box: inBox ? $from.index(2) : undefined,
			offSlide: inBox && isOffItsSlide($from.node(3)),
		};
	}

	it.each([
		["here", "kim"],
		["by somebody else", "sam"],
	] as const)(
		"moves on to the next box of its slide when the box it is in is deleted %s",
		(_, who) => {
			const people = twoPeople({ onStage: true });
			const { kim } = people;
			caretIn(kim, 0, 0);

			make(people[who], (state) => removeBox(state, slideStart(state.doc, 0), boxIndex(0)));

			expect(offSlide(kim.state.doc, 0)).toEqual([true, false]);
			expect(whereCaretIs(kim)).toEqual({ slide: 0, box: 1, offSlide: false });
		},
	);

	it("moves on past a deleted box it would land in when the slide before it is removed", () => {
		const { kim } = twoPeople({ onStage: true });
		make(kim, (state) => removeBox(state, slideStart(state.doc, 1), boxIndex(0)));
		caretIn(kim, 0, 1);

		make(kim, (state) => removeSlide(state, slideIndex(0)));

		expect(offSlide(kim.state.doc, 0)).toEqual([true, false, false]);
		expect(whereCaretIs(kim)).toEqual({ slide: 0, box: 1, offSlide: false });
	});

	it("moves back to the box before it when somebody's undo takes the box it is in off the slide again", () => {
		const { kim, sam } = twoPeople({ onStage: true });
		make(sam, (state) => removeBox(state, slideStart(state.doc, 0), boxIndex(1)));
		pause(sam);
		make(sam, (state) => resetLayout(state, slideIndex(0)));
		pause(sam);
		caretIn(kim, 0, 1);

		sam.commands.undo();

		expect(offSlide(kim.state.doc, 0)).toEqual([false, true]);
		expect(whereCaretIs(kim)).toEqual({ slide: 0, box: 0, offSlide: false });
	});
});

describe("a slide placed by one person while another types in it", () => {
	it.each([
		["once the placement has reached the one typing", false],
		["when neither has what the other did yet", true],
	] as const)("keeps both the placement and the typing, %s", (_, atOnce) => {
		const { kim, sam, apart } = twoPeople();
		const placeAndType = () => {
			make(kim, (state) =>
				placeBox(state, slideStart(state.doc, 0), boxIndex(1), MOVED_LIST, DRAWN_GOALS),
			);
			sam.view.dispatch(sam.state.tr.insertText(" for launch", titleEnd(sam.state.doc, 0)));
		};

		if (atOnce) apart(placeAndType);
		else placeAndType();

		for (const deck of [kim.state.doc, sam.state.doc]) {
			expect(placementOf(deck.child(0))).toEqual([DRAWN_GOALS[0], MOVED_LIST]);
			expect(titlesOf(deck)[0]).toBe("Goals for launch");
		}
	});
});

describe("a suggestion across several slides, settled while a layout suggested between them waits", () => {
	/**
	 * Kim suggests laying slide 2 out in two columns. Then Sam suggests, as one
	 * suggestion, a word more on the titles of slides 1 and 3, so it reaches
	 * from before slide 2 to after it.
	 */
	function layoutBetween() {
		const { kim, sam } = twoPeople({ deck: [GOALS, LAUNCH, PEOPLE].join("\n\n---\n\n") });
		enableSuggestChanges(kim.state, kim.view.dispatch);
		const layout = changeLayout(kim.state, slideIndex(1), "columns");
		if (!layout) throw new Error("No change");
		dispatchAsOneChange(kim, layout, "Kim");
		enableSuggestChanges(sam.state, sam.view.dispatch);
		const titles = sam.state.tr
			.insertText(" now", titleEnd(sam.state.doc, 2))
			.insertText(" now", titleEnd(sam.state.doc, 0));
		dispatchAsOneChange(sam, titles, "Sam");
		return { kim, sam };
	}

	/** What slide 2's body holds once its layout is settled, by the layout it is left with. */
	const LAUNCH_BOXES = {
		columns: ["heading: Launch", "bulletList: Brief salesBook the room", "paragraph: "],
		bullets: ["heading: Launch", "bulletList: Brief salesBook the room"],
	};

	it.each([
		["accept", "accept", "columns"],
		["accept", "reject", "bullets"],
		["reject", "accept", "columns"],
		["reject", "reject", "bullets"],
	] as const)(
		"leaves the layout waiting whole when the one across slides is %sed, to be %sed as it should be",
		(across, then, layout) => {
			const { kim, sam } = layoutBetween();
			const launch = slidesOf(kim.state.doc)[1];
			const spanning = pendingSuggestions(kim.state.doc).find(({ by }) => by.name === "Sam");
			if (!launch || !spanning) throw new Error("No slide 2, or no suggestion across it");
			expect(spanning.from).toBeLessThan(launch.pos);
			expect(spanning.to).toBeGreaterThan(launch.pos + launch.node.nodeSize);

			settlingSuggestion(spanning.id, across)(kim.state, kim.view.dispatch);

			for (const deck of [kim.state.doc, sam.state.doc]) {
				expect(deck.child(1).toJSON()).toEqual(launch.node.toJSON());
				expect(pendingSuggestions(deck)).toMatchObject([
					{ by: { name: "Kim" }, slides: { layout: "columns" } },
				]);
			}

			const [waiting] = pendingSuggestions(sam.state.doc);
			if (!waiting) throw new Error("No suggestion");
			settlingSuggestion(waiting.id, then)(sam.state, sam.view.dispatch);

			for (const deck of [kim.state.doc, sam.state.doc]) {
				expect(pendingSuggestions(deck)).toEqual([]);
				expect(deck.child(1).attrs.layout).toBe(layout);
				expect(boxContentsOf(deck)[1]).toEqual(LAUNCH_BOXES[layout]);
				expect(unfitted(deck)).toEqual([]);
			}
		},
	);
});

describe("a deck's slides, moved and removed", () => {
	it("moves a slide, keeping what it holds", () => {
		const { kim, sam } = twoPeople();

		const move = moveSlideTo(kim.state, slideIndex(0), slideIndex(1));
		if (!move) throw new Error("No move");
		kim.view.dispatch(move);

		expect(wordsOf(sam.state.doc)).toEqual([
			"People and botsPeople typeBots suggest",
			"GoalsShip on FridayTell support first",
		]);
		expect(moveSlideTo(kim.state, slideIndex(1), slideIndex(2))).toBeUndefined();
		expect(moveSlideTo(kim.state, slideIndex(1), slideIndex(1))).toBeUndefined();
	});

	it.each([
		["later", 0, 2, ["People and bots", "Launch", "Goals", "Thanks"]],
		["earlier", 3, 1, ["Goals", "Thanks", "People and bots", "Launch"]],
	] as const)(
		"moves a slide several places %s in one change, keeping the caret in it",
		(_, from, to, titles) => {
			const { kim, sam } = twoPeople({ deck: FOUR });
			const words = wordsOf(kim.state.doc);

			const move = moveSlideTo(kim.state, slideIndex(from), slideIndex(to));
			if (!move) throw new Error("No move");
			dispatchAsOneChange(kim, move, "Kim");

			expect(titlesOf(sam.state.doc)).toEqual(titles);
			expect(wordsOf(sam.state.doc).sort()).toEqual(words.sort());
			expect(slideIndexAt(kim.state.doc, kim.state.selection.from)).toBe(to);
		},
	);

	it("never removes a deck's last slide", () => {
		const { kim } = twoPeople();

		const removal = removeSlide(kim.state, slideIndex(0));
		if (!removal) throw new Error("No removal");
		kim.view.dispatch(removal);

		expect(kim.state.doc.childCount).toBe(1);
		expect(removeSlide(kim.state, slideIndex(0))).toBeUndefined();
	});
});

describe("a slide moved several places as a suggestion", () => {
	/** Kim, suggesting, moves the slide at `from` in a deck of four to stand at `to`. */
	function suggestedMove(from: number, to: number) {
		const { kim, sam } = twoPeople({ deck: FOUR });
		const words = wordsOf(kim.state.doc);
		enableSuggestChanges(kim.state, kim.view.dispatch);
		const move = moveSlideTo(kim.state, slideIndex(from), slideIndex(to));
		if (!move) throw new Error("No move");
		dispatchAsOneChange(kim, move, "Kim");
		return { kim, sam, words };
	}

	/** Each slide's title, and whether somebody proposes adding or removing it. */
	const proposalsOf = (deck: Node) =>
		deck.children.map((slide, index) => [titlesOf(deck)[index], proposedChangeOf(slide)]);

	it.each([
		[
			"later",
			0,
			2,
			[
				["Goals", "removing"],
				["People and bots", undefined],
				["Launch", undefined],
				["Goals", "adding"],
				["Thanks", undefined],
			],
		],
		[
			"earlier",
			3,
			1,
			[
				["Goals", undefined],
				["Thanks", "adding"],
				["People and bots", undefined],
				["Launch", undefined],
				["Thanks", "removing"],
			],
		],
	] as const)(
		"is one suggestion when %s: the slide proposed for removal where it was, and for adding where it goes",
		(_, from, to, proposals) => {
			const { sam } = suggestedMove(from, to);

			expect(proposalsOf(sam.state.doc)).toEqual(proposals);
			expect(pendingSuggestions(sam.state.doc)).toMatchObject([
				{ by: { kind: "person", name: "Kim" }, slides: { adds: true, removes: true } },
			]);
		},
	);

	it.each([
		["later", "accepted", 0, 2, "accept", ["People and bots", "Launch", "Goals", "Thanks"]],
		["later", "undone", 0, 2, "reject", ["Goals", "People and bots", "Launch", "Thanks"]],
		["earlier", "accepted", 3, 1, "accept", ["Goals", "Thanks", "People and bots", "Launch"]],
		["earlier", "undone", 3, 1, "reject", ["Goals", "People and bots", "Launch", "Thanks"]],
	] as const)(
		"moved %s and %s, leaves every slide once, in the order it gives",
		(_, __, from, to, how, titles) => {
			const { kim, sam, words } = suggestedMove(from, to);
			const [suggestion] = pendingSuggestions(sam.state.doc);
			if (!suggestion) throw new Error("No suggestion");

			settlingSuggestion(suggestion.id, how)(sam.state, sam.view.dispatch);

			for (const deck of [sam.state.doc, kim.state.doc]) {
				expect(pendingSuggestions(deck)).toEqual([]);
				expect(titlesOf(deck)).toEqual(titles);
				expect(wordsOf(deck).sort()).toEqual([...words].sort());
			}
		},
	);
});

describe("a slide moved as a suggestion beside a new slide somebody suggests", () => {
	/**
	 * In a deck of four, `proposer` suggests a new slide after the first, so
	 * it stands second; then Kim, suggesting, moves the slide at `from` to
	 * stand at `to`.
	 */
	function moveBesideNewSlide(proposer: "Kim" | "Sam", from: number, to: number) {
		const { kim, sam } = twoPeople({ deck: FOUR });
		const editors = { Kim: kim, Sam: sam };
		for (const editor of [kim, sam]) enableSuggestChanges(editor.state, editor.view.dispatch);
		const proposing = editors[proposer];
		dispatchAsOneChange(proposing, addSlide(proposing.state, slideIndex(0), "title"), proposer);
		const before = titlesOf(kim.state.doc);
		const move = moveSlideTo(kim.state, slideIndex(from), slideIndex(to));
		if (!move) throw new Error("No move");
		dispatchAsOneChange(kim, move, "Kim");
		return { kim, sam, before };
	}

	/** The suggestions waiting in `deck`, by who made them and what they do to its slides. */
	const suggestionsIn = (deck: Node) =>
		pendingSuggestions(deck).map(({ by, slides }) => ({ by: by.name, ...slides }));

	const NEW_SLIDE = { adds: true, removes: false, layout: undefined };
	const MOVE = { by: "Kim", adds: true, removes: true, layout: undefined };

	it.each([
		["lands beside Kim's own", "Kim", 4, 2, ["Goals", "", "Thanks", "People and bots", "Launch"]],
		["lands beside Sam's", "Sam", 4, 2, ["Goals", "", "Thanks", "People and bots", "Launch"]],
		[
			"leaves from beside Kim's own",
			"Kim",
			2,
			4,
			["Goals", "", "Launch", "Thanks", "People and bots"],
		],
		["leaves from beside Sam's", "Sam", 2, 4, ["Goals", "", "Launch", "Thanks", "People and bots"]],
	] as const)(
		"is a suggestion of its own when it %s, which waits whole however the move is settled",
		(_, proposer, from, to, moved) => {
			const { sam, before } = moveBesideNewSlide(proposer, from, to);

			expect(suggestionsIn(sam.state.doc)).toEqual(
				expect.arrayContaining([{ by: proposer, ...NEW_SLIDE }, MOVE]),
			);
			expect(suggestionsIn(sam.state.doc)).toHaveLength(2);
			// The new slide, the moving slide where it was, and where it goes.
			expect(sam.state.doc.childCount).toBe(6);

			for (const [how, titles] of [
				["accept", moved],
				["reject", before],
			] as const) {
				const { kim: settler } = moveBesideNewSlide(proposer, from, to);
				const move = pendingSuggestions(settler.state.doc).find(({ slides }) => slides?.removes);
				if (!move) throw new Error("No move");
				settlingSuggestion(move.id, how)(settler.state, settler.view.dispatch);

				expect(titlesOf(settler.state.doc)).toEqual(titles);
				expect(suggestionsIn(settler.state.doc)).toEqual([{ by: proposer, ...NEW_SLIDE }]);
				expect(proposedChangeOf(settler.state.doc.child(1))).toBe("adding");
			}
		},
	);
});

describe("a person's own suggestion, undone and redone", () => {
	/** Somebody's change as a suggestion, made in their editor. */
	type Suggest = (editor: Editor, name: string) => void;

	/** Makes `change`, one of the deck's own, as `name`'s one suggestion. */
	const asOne =
		(change: (state: EditorState) => Transaction | undefined): Suggest =>
		(editor, name) => {
			const changing = change(editor.state);
			if (!changing) throw new Error("No change");
			dispatchAsOneChange(editor, changing, name);
		};

	const SUGGESTIONS: [string, Suggest][] = [
		[
			"typing",
			(editor) =>
				editor.view.dispatch(editor.state.tr.insertText(" now", titleEnd(editor.state.doc, 0))),
		],
		["adding a slide", asOne((state) => addSlide(state, slideIndex(0), "title"))],
		["removing a slide", asOne((state) => removeSlide(state, slideIndex(1)))],
		["changing a slide's layout", asOne((state) => changeLayout(state, slideIndex(0), "columns"))],
		["moving a slide", asOne((state) => moveSlideTo(state, slideIndex(0), slideIndex(2)))],
	];

	it.each(SUGGESTIONS)(
		"takes back %s whole with one undo, leaving the edit made before it, and brings it back with one redo",
		(_, suggest) => {
			const { kim, sam } = twoPeople({ deck: FOUR });
			pause(kim);
			kim.view.dispatch(kim.state.tr.insertText("Our ", titleStart(kim.state.doc, 3)));
			pause(kim);
			const edited = sam.state.doc.toJSON();
			enableSuggestChanges(kim.state, kim.view.dispatch);
			suggest(kim, "Kim");
			pause(kim);
			const suggested = sam.state.doc.toJSON();
			expect(pendingSuggestions(sam.state.doc)).toHaveLength(1);

			kim.commands.undo();

			expect(sam.state.doc.toJSON()).toEqual(edited);
			expect(kim.state.doc.toJSON()).toEqual(edited);

			kim.commands.redo();

			expect(sam.state.doc.toJSON()).toEqual(suggested);
			expect(pendingSuggestions(kim.state.doc)).toHaveLength(1);
		},
	);

	it.each(SUGGESTIONS)(
		"leaves somebody else's suggestion when the person undoes %s of their own",
		(_, suggest) => {
			const { kim, sam } = twoPeople({ deck: FOUR });
			pause(kim);
			for (const editor of [kim, sam]) enableSuggestChanges(editor.state, editor.view.dispatch);
			sam.view.dispatch(sam.state.tr.insertText(" too", titleEnd(sam.state.doc, 3)));
			const samsOnly = kim.state.doc.toJSON();
			suggest(kim, "Kim");
			pause(kim);

			kim.commands.undo();

			expect(kim.state.doc.toJSON()).toEqual(samsOnly);
			expect(pendingSuggestions(sam.state.doc)).toMatchObject([{ by: { name: "Sam" } }]);
		},
	);
});

describe("slides added or removed as suggestions one beside another", () => {
	/** Adds a slide after the slide at `step`, as the first or second of two changes. */
	const ADD_A_SLIDE = (state: EditorState, step: number) =>
		addSlide(state, slideIndex(step), "title");
	/** Removes the slide after the one at `step`, as the first or second of two changes. */
	const REMOVE_A_SLIDE = (state: EditorState, step: number) =>
		removeSlide(state, slideIndex(step + 1));

	it.each([
		[
			"added",
			"earlier",
			"accept",
			ADD_A_SLIDE,
			["Goals", "", "", "People and bots", "Launch", "Thanks"],
		],
		[
			"added",
			"later",
			"accept",
			ADD_A_SLIDE,
			["Goals", "", "", "People and bots", "Launch", "Thanks"],
		],
		[
			"added",
			"earlier",
			"reject",
			ADD_A_SLIDE,
			["Goals", "", "People and bots", "Launch", "Thanks"],
		],
		["added", "later", "reject", ADD_A_SLIDE, ["Goals", "", "People and bots", "Launch", "Thanks"]],
		["removed", "earlier", "accept", REMOVE_A_SLIDE, ["Goals", "Launch", "Thanks"]],
		["removed", "later", "accept", REMOVE_A_SLIDE, ["Goals", "People and bots", "Thanks"]],
		[
			"removed",
			"earlier",
			"reject",
			REMOVE_A_SLIDE,
			["Goals", "People and bots", "Launch", "Thanks"],
		],
		[
			"removed",
			"later",
			"reject",
			REMOVE_A_SLIDE,
			["Goals", "People and bots", "Launch", "Thanks"],
		],
	] as const)(
		"are a suggestion each when %s, so settling the %s with %s leaves the other waiting",
		(_, which, how, change, titles) => {
			const { kim, sam } = twoPeople({ deck: FOUR });
			enableSuggestChanges(kim.state, kim.view.dispatch);
			for (const step of [0, 1]) {
				const changing = change(kim.state, step);
				if (!changing) throw new Error("No change");
				dispatchAsOneChange(kim, changing, "Kim");
			}
			const pending = pendingSuggestions(sam.state.doc);
			expect(pending).toHaveLength(2);
			const settling = pending[which === "earlier" ? 0 : 1];
			if (!settling) throw new Error("No suggestion");

			settlingSuggestion(settling.id, how)(sam.state, sam.view.dispatch);

			expect(titlesOf(sam.state.doc)).toEqual(titles);
			expect(pendingSuggestions(sam.state.doc)).toHaveLength(1);
		},
	);
});

describe("a slide put in front of a slide somebody proposes removing", () => {
	/** A slide's title, whether somebody proposes adding or removing it, and who. */
	type Proposal = readonly [string, "adding" | "removing" | undefined, string | undefined];

	const SLIDE_PROPOSALS = { [SUGGESTED_INSERTION]: true, [SUGGESTED_DELETION]: true };

	const proposalsOf = (deck: Node): Proposal[] =>
		deck.children.map((slide, index) => {
			const mark = slide.marks.find(({ type }) => type.name in SLIDE_PROPOSALS);
			const by = mark ? suggestionBy(String(mark.attrs.id)).name : undefined;
			return [titlesOf(deck)[index] ?? "", proposedChangeOf(slide), by];
		});

	/** `proposals` once `who`'s suggestion is accepted, keeping what it adds, or undone, keeping what it removes. */
	const settled = (proposals: readonly Proposal[], who: string, how: "accept" | "reject") =>
		proposals.flatMap(([title, change, by]): Proposal[] => {
			if (by !== who) return [[title, change, by]];
			const kept = how === "accept" ? change === "adding" : change === "removing";
			return kept ? [[title, undefined, undefined]] : [];
		});

	/**
	 * Kim's change, made where Sam proposes removing the slide at `removing`:
	 * the deck as it then reads with both suggestions waiting, and where the
	 * stage shows Kim's slide, as `LiveDeck` picks it, the deck before and after.
	 */
	interface InFront {
		removing: number;
		change: (state: EditorState) => Transaction | undefined;
		suggested: Proposal[];
		shown: (before: Node, after: Node) => number;
	}

	const IN_FRONT: [string, InFront][] = [
		[
			"moved up from its menu",
			{
				removing: 1,
				change: (state) => moveSlideTo(state, slideIndex(2), slideIndex(1)),
				suggested: [
					["Goals", undefined, undefined],
					["Launch", "adding", "Kim"],
					["People and bots", "removing", "Sam"],
					["Launch", "removing", "Kim"],
					["Thanks", undefined, undefined],
				],
				shown: (before, after) => placeOfMovedSlide(before, after, slideIndex(2), slideIndex(1)),
			},
		],
		[
			// The drag passes `to` for the gap a slide is dropped in: here the gap above the second slide.
			"dragged up to the gap above it",
			{
				removing: 1,
				change: (state) => moveSlideTo(state, slideIndex(3), slideIndex(1)),
				suggested: [
					["Goals", undefined, undefined],
					["Thanks", "adding", "Kim"],
					["People and bots", "removing", "Sam"],
					["Launch", undefined, undefined],
					["Thanks", "removing", "Kim"],
				],
				shown: (before, after) => placeOfMovedSlide(before, after, slideIndex(3), slideIndex(1)),
			},
		],
		[
			"dragged down to the gap above it",
			{
				removing: 2,
				change: (state) => moveSlideTo(state, slideIndex(0), slideIndex(1)),
				suggested: [
					["Goals", "removing", "Kim"],
					["People and bots", undefined, undefined],
					["Goals", "adding", "Kim"],
					["Launch", "removing", "Sam"],
					["Thanks", undefined, undefined],
				],
				shown: (before, after) => placeOfMovedSlide(before, after, slideIndex(0), slideIndex(1)),
			},
		],
		[
			"added after the slide before it",
			{
				removing: 1,
				change: (state) => addSlide(state, slideIndex(0), "title"),
				suggested: [
					["Goals", undefined, undefined],
					["", "adding", "Kim"],
					["People and bots", "removing", "Sam"],
					["Launch", undefined, undefined],
					["Thanks", undefined, undefined],
				],
				// The slide after the one on the stage, which a new slide is added after.
				shown: () => 1,
			},
		],
	];

	/** Sam proposes removing a slide, then Kim makes `change`, suggesting or editing. */
	function inFront({ removing, change }: InFront, kimSuggests: boolean) {
		const { kim, sam } = twoPeople({ deck: FOUR });
		enableSuggestChanges(sam.state, sam.view.dispatch);
		if (kimSuggests) enableSuggestChanges(kim.state, kim.view.dispatch);
		const removal = removeSlide(sam.state, slideIndex(removing));
		if (!removal) throw new Error("No removal");
		dispatchAsOneChange(sam, removal, "Sam");
		const before = kim.state.doc;
		const kims = change(kim.state);
		if (!kims) throw new Error("No change");
		dispatchAsOneChange(kim, kims, "Kim");
		return { kim, sam, before };
	}

	it.each(IN_FRONT)(
		"stands where Kim puts it when %s as a suggestion, shown on the stage, with Sam's removal waiting",
		(_, putting) => {
			const { kim, sam, before } = inFront(putting, true);

			expect(proposalsOf(sam.state.doc)).toEqual(putting.suggested);
			const kims = putting.suggested.find(([, change, by]) => by === "Kim" && change === "adding");
			expect(proposalsOf(kim.state.doc)[putting.shown(before, kim.state.doc)]).toEqual(kims);
			expect(pendingSuggestions(sam.state.doc).map(({ by, slides }) => [by.name, slides])).toEqual(
				expect.arrayContaining([["Sam", { adds: false, removes: true, layout: undefined }]]),
			);
		},
	);

	it.each(
		IN_FRONT.flatMap(([what, putting]) =>
			(["Kim", "Sam"] as const).flatMap((who) =>
				(["accept", "reject"] as const).map((how) => [what, who, how, putting] as const),
			),
		),
	)(
		"when %s, leaves the order a person expects once %s's suggestion is %sed, the other waiting",
		(_, who, how, putting) => {
			const { sam } = inFront(putting, true);
			const settling = pendingSuggestions(sam.state.doc).find(({ by }) => by.name === who);
			if (!settling) throw new Error("No suggestion");

			settlingSuggestion(settling.id, how)(sam.state, sam.view.dispatch);

			expect(proposalsOf(sam.state.doc)).toEqual(settled(putting.suggested, who, how));
			expect(pendingSuggestions(sam.state.doc).map(({ by }) => by.name)).toEqual([
				who === "Kim" ? "Sam" : "Kim",
			]);
		},
	);

	it.each(IN_FRONT)(
		"stands where Kim puts it when %s while editing, shown on the stage, with Sam's removal waiting",
		(_, putting) => {
			const { kim, sam, before } = inFront(putting, false);

			const made = settled(putting.suggested, "Kim", "accept");
			expect(proposalsOf(sam.state.doc)).toEqual(made);
			const kims = putting.suggested.find(([, change, by]) => by === "Kim" && change === "adding");
			expect(proposalsOf(kim.state.doc)[putting.shown(before, kim.state.doc)]?.[0]).toBe(kims?.[0]);
		},
	);
});
