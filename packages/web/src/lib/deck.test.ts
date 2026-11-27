import { enableSuggestChanges } from "@handlewithcare/prosemirror-suggest-changes";
import { deckFromHtml } from "@sugabots/contracts/deck-html";
import {
	liveDocumentExtensions,
	SUGGESTED_DELETION,
	SUGGESTED_INSERTION,
	suggestionBy,
} from "@sugabots/contracts/live-document";
import {
	bodyOf,
	boxAttributesOf,
	FIRST_BOX_IN_SLIDE,
	layoutOf,
	SLIDE_BODY,
} from "@sugabots/contracts/live-slides";
import type { Frame } from "@sugabots/contracts/slide-geometry";
import { templateBoxOf } from "@sugabots/contracts/slide-layouts";
import { Editor } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import type { Node } from "@tiptap/pm/model";
import { type EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { afterEach, describe, expect, it } from "vitest";
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from "yjs";
import {
	addSlide,
	BOX_REMOVAL_BLOCKED_WORDS,
	type BoxIndex,
	boxRemovalBlocked,
	changeLayout,
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

/** Reads a deck's HTML inert, as the app does. */
const readHtml = new DOMParser();

/** A slide of `layout` holding `boxes`, as a deck's HTML writes it, each box where its layout places it. */
const slide = (layout: string, ...boxes: string[]) =>
	`<section data-slide data-layout="${layout}"><div data-slide-body>${boxes.join("")}</div></section>`;

/** A box for `role` holding `html`. */
const box = (role: string, html: string) => `<div data-slide-box data-role="${role}">${html}</div>`;

const list = (...items: string[]) =>
	`<ul>${items.map((item) => `<li><p>${item}</p></li>`).join("")}</ul>`;

const GOALS = slide(
	"bullets",
	box("title", "<h2>Goals</h2>"),
	box("body", list("Ship on Friday", "Tell support first")),
);
const PEOPLE = slide(
	"columns",
	box("title", "<h2>People and bots</h2>"),
	box("leftColumn", list("People type")),
	box("rightColumn", list("Bots suggest")),
);
const DECK = GOALS + PEOPLE;

/**
 * Two people in one live deck, `deck` in its HTML, each in their own editor,
 * with what either does reaching the other, but for what they do `apart`.
 */
function twoPeople({ deck = DECK }: { deck?: string } = {}) {
	const [kims, sams] = [new Doc(), new Doc()];
	let inTouch = true;
	kims.on("update", (update, origin) => {
		if (inTouch && origin !== "sync") applyUpdate(sams, update, "sync");
	});
	sams.on("update", (update, origin) => {
		if (inTouch && origin !== "sync") applyUpdate(kims, update, "sync");
	});
	const editorOf = (document: Doc, name: string) => {
		const editor = new Editor({
			element: window.document.createElement("div"),
			extensions: [
				...liveDocumentExtensions({ kind: "slides", undo: false }),
				Suggesting,
				Collaboration.configure({ document }),
			],
		});
		suggestingAs(editor, name);
		editors.push(editor);
		return editor;
	};
	const [kim, sam] = [editorOf(kims, "Kim"), editorOf(sams, "Sam")];
	kim.commands.setContent(deckFromHtml(deck, readHtml).toJSON());
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

/** What each slide's body holds: each box, by the names of its blocks, and its words. */
const boxContentsOf = (deck: Node) =>
	deck.children.map((slide) =>
		bodyOf(slide).children.map(
			(box) => `${box.children.map((block) => block.type.name).join(" ")}: ${box.textContent}`,
		),
	);

/** What each box of the slide at `index` is for. */
const rolesOn = (deck: Node, index: number) =>
	bodyOf(deck.child(index)).children.map((box) => boxAttributesOf(box).role);

/** Where each box of the slide at `index` is. */
const framesOn = (deck: Node, index: number) =>
	bodyOf(deck.child(index)).children.map((box) => boxAttributesOf(box).frame);

/** The words on each slide, in order, whatever holds them. */
const wordsOf = (deck: Node) => deck.children.map((slide) => bodyOf(slide).textContent);

const LAUNCH = slide(
	"bullets",
	box("title", "<h2>Launch</h2>"),
	box("body", list("Brief sales", "Book the room")),
);
const THANKS = slide("title", box("title", "<h2>Thanks</h2>"));
const FOUR = [GOALS, PEOPLE, LAUNCH, THANKS].join("");

/** The title of each slide, in order: the words of its first box. */
const titlesOf = (deck: Node) =>
	deck.children.map((slide) => bodyOf(slide).maybeChild(0)?.textContent ?? "");

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

/** Where the bullets layout places a box for `role`. */
function bulletsFrame(role: "title" | "body"): Frame {
	const template = templateBoxOf("bullets", role);
	if (!template) throw new Error(`The bullets layout places no ${role}`);
	return template.frame;
}

describe("a slide's layout, changed", () => {
	it("is suggested as one suggestion: the new layout on the slide, the box that moves drawn anew, and the box it lacks to add", () => {
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
			["Ship on FridayTell support first", ["modification", "modification"]],
			["", ["insertion"]],
		]);
		expect(rolesOn(sam.state.doc, 0)).toEqual(["title", "leftColumn", "rightColumn"]);
		// One suggestion, which says what it does.
		expect(pendingSuggestions(sam.state.doc)).toMatchObject([
			{ by: { kind: "person", name: "Kim" }, slides: { layout: "columns" } },
		]);
	});

	it.each([
		["accepted", "accept", "columns", ["title", "leftColumn", "rightColumn"]],
		["undone", "reject", "bullets", ["title", "body"]],
	] as const)(
		"keeps every word once the suggestion is %s, each box for what the layout left it",
		(_, how, layout, roles) => {
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
				expect(rolesOn(deck, 0)).toEqual(roles);
				expect(wordsOf(deck)[0]).toBe("GoalsShip on FridayTell support first");
			}
		},
	);

	it("undoes a suggested layout that moves nothing, as a blank one, which only changes the slide's layout", () => {
		const { kim, sam } = twoPeople();
		enableSuggestChanges(kim.state, kim.view.dispatch);
		const change = changeLayout(kim.state, slideIndex(1), "blank");
		if (!change) throw new Error("No change");
		dispatchAsOneChange(kim, change, "Kim");
		expect(sam.state.doc.child(1).attrs.layout).toBe("blank");
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
		expect(rolesOn(sam.state.doc, 1)).toEqual(["title", "body"]);
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

/** The goals' list moved down. */
const MOVED_LIST: Frame = { ...bulletsFrame("body"), y: 200 };
/** The goals' title made narrower and taller. */
const RESIZED_TITLE: Frame = { ...bulletsFrame("title"), width: 400, height: 60 };

describe("a slide's boxes, moved by hand", () => {
	it("moves only the box moved", () => {
		const { kim, sam } = twoPeople();

		make(kim, (state) => placeBox(state, slideStart(state.doc, 0), boxIndex(1), MOVED_LIST));

		expect(framesOn(sam.state.doc, 0)).toEqual([bulletsFrame("title"), MOVED_LIST]);
	});

	it.each([
		["moved", 1, MOVED_LIST],
		["resized", 0, RESIZED_TITLE],
	] as const)(
		"are %s at once, never as a suggestion, even while the person is suggesting",
		(_, box, frame) => {
			const { kim, sam } = twoPeople();
			enableSuggestChanges(kim.state, kim.view.dispatch);

			make(kim, (state) => placeBox(state, slideStart(state.doc, 0), boxIndex(box), frame));

			expect(framesOn(sam.state.doc, 0)[box]).toEqual(frame);
			expect(pendingSuggestions(sam.state.doc)).toEqual([]);
		},
	);

	it("stretches a shape's outline with its box", () => {
		const arrow = slide(
			"blank",
			'<div data-slide-box style="left: 100px; top: 100px; width: 200px; height: 100px"><svg viewBox="0 0 200 100"><path d="M 0 0 L 200 50 L 0 100 Z" fill="#f59e0b"/></svg><p></p></div>',
		);
		const { kim, sam } = twoPeople({ deck: arrow });

		make(kim, (state) =>
			placeBox(state, slideStart(state.doc, 0), boxIndex(0), {
				x: 100,
				y: 100,
				width: 400,
				height: 50,
			}),
		);

		const shape = boxAttributesOf(bodyOf(sam.state.doc.child(0)).child(0));
		expect(shape.path).toBe("M 0 0 L 400 25 L 0 50 Z");
	});

	it.each([
		["editing", false],
		["suggesting, never as a suggestion", true],
	] as const)(
		"are put back where the slide's layout places them by resetting it while %s, each holding what it held",
		(_, suggests) => {
			const { kim, sam } = twoPeople();
			make(kim, (state) => placeBox(state, slideStart(state.doc, 0), boxIndex(1), MOVED_LIST));
			make(kim, (state) => placeBox(state, slideStart(state.doc, 0), boxIndex(0), RESIZED_TITLE));
			if (suggests) enableSuggestChanges(kim.state, kim.view.dispatch);

			make(kim, (state) => resetLayout(state, slideIndex(0)));

			for (const deck of [sam.state.doc, kim.state.doc]) {
				expect(framesOn(deck, 0)).toEqual([bulletsFrame("title"), bulletsFrame("body")]);
				expect(boxContentsOf(deck)[0]).toEqual([
					"heading: Goals",
					"bulletList: Ship on FridayTell support first",
				]);
			}
			expect(pendingSuggestions(sam.state.doc)).toEqual([]);
			expect(resetLayout(kim.state, slideIndex(0))).toBeUndefined();
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
		expect(bodyOf(kim.state.doc.child(0)).childCount).toBe(2);
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
		expect(boxContentsOf(sam.state.doc)[0]).toEqual(["heading: Goals"]);

		kim.commands.undo();

		expect(sam.state.doc.toJSON()).toEqual(edited);
		expect(kim.state.doc.toJSON()).toEqual(edited);
	});
});

describe("the caret, when the box it is in is deleted", () => {
	/** Puts `editor`'s caret at the start of the box at `box` of the slide at `slide`. */
	function caretIn(editor: Editor, slide: number, box: number) {
		const { at } = nthBox(editor.state.doc, slide, box);
		editor.view.dispatch(
			editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(at + 1))),
		);
	}

	/**
	 * The places of the slide and of the box the caret is in. The box is
	 * `undefined` outside the slide's boxes, as in its notes.
	 */
	function whereCaretIs(editor: Editor) {
		const { $from } = editor.state.selection;
		const inBox = $from.depth >= 3 && $from.node(2).type.name === SLIDE_BODY;
		return { slide: $from.index(0), box: inBox ? $from.index(2) : undefined };
	}

	it("moves on to the next box of its slide", () => {
		const { kim } = twoPeople();
		caretIn(kim, 1, 0);

		make(kim, (state) => removeBox(state, slideStart(state.doc, 1), boxIndex(0)));

		expect(titlesOf(kim.state.doc)[1]).toBe("People type");
		expect(whereCaretIs(kim)).toEqual({ slide: 1, box: 0 });
	});

	it("moves back to the box before it when it was its slide's last", () => {
		const { kim } = twoPeople();
		caretIn(kim, 1, 2);

		make(kim, (state) => removeBox(state, slideStart(state.doc, 1), boxIndex(2)));

		expect(whereCaretIs(kim)).toEqual({ slide: 1, box: 1 });
	});

	it("moves to the slide's notes when it was the last box on its slide", () => {
		const { kim } = twoPeople();
		make(kim, (state) => removeBox(state, slideStart(state.doc, 0), boxIndex(0)));
		caretIn(kim, 0, 0);

		make(kim, (state) => removeBox(state, slideStart(state.doc, 0), boxIndex(0)));

		expect(bodyOf(kim.state.doc.child(0)).childCount).toBe(0);
		expect(whereCaretIs(kim)).toEqual({ slide: 0, box: undefined });
	});
});

describe("a box moved by one person while another types in it", () => {
	it.each([
		["once the move has reached the one typing", false],
		["when neither has what the other did yet", true],
	] as const)("keeps both the move and the typing, %s", (_, atOnce) => {
		const { kim, sam, apart } = twoPeople();
		const moveAndType = () => {
			make(kim, (state) => placeBox(state, slideStart(state.doc, 0), boxIndex(0), RESIZED_TITLE));
			sam.view.dispatch(sam.state.tr.insertText(" for launch", titleEnd(sam.state.doc, 0)));
		};

		if (atOnce) apart(moveAndType);
		else moveAndType();

		for (const deck of [kim.state.doc, sam.state.doc]) {
			expect(framesOn(deck, 0)[0]).toEqual(RESIZED_TITLE);
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
		const { kim, sam } = twoPeople({ deck: [GOALS, LAUNCH, PEOPLE].join("") });
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
				expect(layoutOf(deck.child(1))).toBe(layout);
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
