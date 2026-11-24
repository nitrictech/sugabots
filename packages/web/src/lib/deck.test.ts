import {
	disableSuggestChanges,
	enableSuggestChanges,
} from "@handlewithcare/prosemirror-suggest-changes";
import { liveDocumentExtensions } from "@sugabots/contracts/live-document";
import { liveDocumentFromMarkdown } from "@sugabots/contracts/live-document-markdown";
import { fitSlideBody, layoutOf, SLIDE_COLUMN } from "@sugabots/contracts/live-slides";
import { Editor, Extension } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import type { Node } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";
import { applyUpdate, Doc } from "yjs";
import { changeLayout, keepSlidesFitting, moveSlide, removeSlide, slidesOf } from "./deck.ts";
import { dispatchAsOneChange, Suggesting, suggestingAs } from "./suggesting.ts";
import { pendingSuggestions, settlingSuggestion } from "./suggestions.ts";

const editors: Editor[] = [];
afterEach(() => {
	for (const editor of editors.splice(0)) editor.destroy();
});

const GOALS = "<!-- layout: bullets -->\n\n## Goals\n\n- Ship on Friday\n- Tell support first";
const PEOPLE =
	"<!-- layout: columns -->\n\n## People and bots\n\n<!-- column -->\n\n- People type\n\n<!-- column -->\n\n- Bots suggest";
const DECK = [GOALS, PEOPLE].join("\n\n---\n\n");

const KeepsSlidesFitting = Extension.create({
	name: "keepsSlidesFitting",
	addProseMirrorPlugins: () => [keepSlidesFitting],
});

/**
 * Two people in one live deck, `deck` in Markdown, each in their own editor,
 * with what either does reaching the other. Kim's editor keeps the slides
 * fitting unless `kimFits` is false, as an editor of an older version
 * wouldn't; Sam's always does.
 */
function twoPeople({ kimFits = true, deck = DECK }: { kimFits?: boolean; deck?: string } = {}) {
	const [kims, sams] = [new Doc(), new Doc()];
	kims.on("update", (update, origin) => origin !== "sync" && applyUpdate(sams, update, "sync"));
	sams.on("update", (update, origin) => origin !== "sync" && applyUpdate(kims, update, "sync"));
	const editorOf = (document: Doc, name: string, fits: boolean) => {
		const editor = new Editor({
			element: window.document.createElement("div"),
			extensions: [
				...liveDocumentExtensions({ kind: "slides", undo: false }),
				Suggesting,
				...(fits ? [KeepsSlidesFitting] : []),
				Collaboration.configure({ document }),
			],
		});
		suggestingAs(editor, name);
		editors.push(editor);
		return editor;
	};
	const [kim, sam] = [editorOf(kims, "Kim", kimFits), editorOf(sams, "Sam", true)];
	kim.commands.setContent(liveDocumentFromMarkdown("slides", deck).toJSON());
	return { kim, sam };
}

/** The slides, by number from 1, whose frame doesn't hold what their layout says. */
const unfitted = (deck: Node) =>
	deck.children.flatMap((slide, index) => {
		const body = slide.child(0);
		return fitSlideBody(body, layoutOf(slide)).eq(body) ? [] : [index + 1];
	});

/** What each slide's frame holds: its blocks and columns by name, and its words. */
const framesOf = (deck: Node) =>
	deck.children.map((slide) =>
		slide.child(0).children.map((part) => `${part.type.name}: ${part.textContent}`),
	);

/** The words on each slide, in order, whatever holds them. */
const wordsOf = (deck: Node) => deck.children.map((slide) => slide.child(0).textContent);

/** Where the frame of the slide at `index` holds its first block. */
const frameStart = (deck: Node, index: number) => (slidesOf(deck)[index]?.pos ?? 0) + 2;

/** Where `slide`'s frame holds its part at `part`, and that part. */
function partAt(deck: Node, slide: number, part: number) {
	const body = deck.child(slide).child(0);
	let at = frameStart(deck, slide);
	for (let index = 0; index < part; index++) at += body.child(index).nodeSize;
	return { at, node: body.child(part) };
}

describe("a deck's slides, kept fitting their layouts", () => {
	it("lays a slide out again after a change here leaves its two columns as one, losing nothing", () => {
		const { kim, sam } = twoPeople();
		const people = kim.state.doc.child(1).child(0);
		const [left, right] = [partAt(kim.state.doc, 1, 1), partAt(kim.state.doc, 1, 2)];
		const joined = kim.schema.nodes[SLIDE_COLUMN]?.create(null, [
			...left.node.content.content,
			...right.node.content.content,
		]);
		if (!joined) throw new Error("No column node");

		kim.view.dispatch(kim.state.tr.replaceWith(left.at, right.at + right.node.nodeSize, joined));

		expect(unfitted(kim.state.doc)).toEqual([]);
		expect(framesOf(kim.state.doc)[1]).toEqual([
			"heading: People and bots",
			"slideColumn: People typeBots suggest",
			"slideColumn: ",
		]);
		// The others get it fitted, as it was made.
		expect(framesOf(sam.state.doc)).toEqual(framesOf(kim.state.doc));
		expect(people.textContent).toBe(kim.state.doc.child(1).child(0).textContent);
	});

	it("brings a column pasted into a slide without columns into its flow, losing nothing", () => {
		const { kim } = twoPeople();
		const list = partAt(kim.state.doc, 0, 1);
		const pasted = kim.schema.nodes[SLIDE_COLUMN]?.create(null, [
			kim.schema.node("paragraph", null, [kim.schema.text("Pasted words")]),
		]);
		if (!pasted) throw new Error("No column node");

		kim.view.dispatch(kim.state.tr.insert(list.at + list.node.nodeSize, pasted));

		expect(unfitted(kim.state.doc)).toEqual([]);
		expect(framesOf(kim.state.doc)[0]).toEqual([
			"heading: Goals",
			"bulletList: Ship on FridayTell support first",
			"paragraph: Pasted words",
		]);
	});

	it("leaves what arrives from somebody else as it arrives, rather than fight it", () => {
		const { kim, sam } = twoPeople({ kimFits: false });
		const right = partAt(kim.state.doc, 1, 2);

		kim.view.dispatch(kim.state.tr.delete(right.at, right.at + right.node.nodeSize));

		expect(unfitted(sam.state.doc)).toEqual([2]);
		expect(framesOf(sam.state.doc)).toEqual(framesOf(kim.state.doc));
	});

	it("leaves a slide with a suggestion waiting in it as it is, until the suggestion is settled", () => {
		const { kim } = twoPeople();
		enableSuggestChanges(kim.state, kim.view.dispatch);
		const goals = partAt(kim.state.doc, 0, 0);
		kim.view.dispatch(kim.state.tr.insertText(" for launch", goals.at + goals.node.nodeSize - 1));
		disableSuggestChanges(kim.state, kim.view.dispatch);
		const extra = kim.schema.nodes[SLIDE_COLUMN]?.create(null, [
			kim.schema.node("paragraph", null, [kim.schema.text("A column too many")]),
		]);
		if (!extra) throw new Error("No column node");

		kim.view.dispatch(kim.state.tr.insert(frameStart(kim.state.doc, 0), extra));

		expect(unfitted(kim.state.doc)).toEqual([1]);
		const [suggestion] = pendingSuggestions(kim.state.doc);
		if (!suggestion) throw new Error("No suggestion");
		settlingSuggestion(suggestion.id, "accept")(kim.state, kim.view.dispatch);
		expect(unfitted(kim.state.doc)).toEqual([]);
		expect(wordsOf(kim.state.doc)[0]).toBe(
			"A column too manyGoals for launchShip on FridayTell support first",
		);
	});
});

describe("a slide's layout, changed", () => {
	it("is suggested as the API suggests it: the new layout on the slide, its old content to remove and its columns to add", () => {
		const { kim, sam } = twoPeople();
		enableSuggestChanges(kim.state, kim.view.dispatch);

		const change = changeLayout(kim.state, 0, "columns");
		if (!change) throw new Error("No change");
		dispatchAsOneChange(kim, change, "Kim");

		const goals = sam.state.doc.child(0);
		expect(goals.attrs.layout).toBe("columns");
		expect(goals.marks.map((mark) => mark.attrs)).toMatchObject([
			{ type: "attr", attrName: "layout", previousValue: "bullets", newValue: "columns" },
		]);
		expect(
			goals
				.child(0)
				.children.map((block) => [block.type.name, block.marks.map((mark) => mark.type.name)]),
		).toEqual([
			["heading", []],
			["bulletList", ["deletion"]],
			["slideColumn", ["insertion"]],
			["slideColumn", ["insertion"]],
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
			const change = changeLayout(kim.state, 0, "columns");
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
		const change = changeLayout(kim.state, 1, "image");
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
		const title = kim.state.doc.child(1).child(0).child(0);

		const change = changeLayout(kim.state, 1, "bullets");
		if (!change) throw new Error("No change");
		dispatchAsOneChange(kim, change, "Kim");

		expect(framesOf(sam.state.doc)[1]).toEqual([
			"heading: People and bots",
			"bulletList: People type",
			"bulletList: Bots suggest",
		]);
		// The title stays the node it was, so someone typing in it keeps what they type.
		expect(kim.state.doc.child(1).child(0).child(0)).toBe(title);
	});

	it("is refused while a suggestion waits in the slide", () => {
		const { kim } = twoPeople();
		enableSuggestChanges(kim.state, kim.view.dispatch);
		const goals = partAt(kim.state.doc, 0, 0);
		kim.view.dispatch(kim.state.tr.insertText(" for launch", goals.at + goals.node.nodeSize - 1));

		expect(changeLayout(kim.state, 0, "quote")).toBeUndefined();
	});
});

describe("a suggestion across several slides, settled while a layout suggested between them waits", () => {
	const LAUNCH = "<!-- layout: bullets -->\n\n## Launch\n\n- Brief sales\n- Book the room";

	/**
	 * Kim suggests laying slide 2 out in two columns. Then Sam suggests, as one
	 * suggestion, a word more on the titles of slides 1 and 3, so it reaches
	 * from before slide 2 to after it.
	 */
	function layoutBetween() {
		const { kim, sam } = twoPeople({ deck: [GOALS, LAUNCH, PEOPLE].join("\n\n---\n\n") });
		enableSuggestChanges(kim.state, kim.view.dispatch);
		const layout = changeLayout(kim.state, 1, "columns");
		if (!layout) throw new Error("No change");
		dispatchAsOneChange(kim, layout, "Kim");
		enableSuggestChanges(sam.state, sam.view.dispatch);
		const [first, third] = [partAt(sam.state.doc, 0, 0), partAt(sam.state.doc, 2, 0)];
		const titles = sam.state.tr
			.insertText(" now", third.at + third.node.nodeSize - 1)
			.insertText(" now", first.at + first.node.nodeSize - 1);
		dispatchAsOneChange(sam, titles, "Sam");
		return { kim, sam };
	}

	/** What slide 2's frame holds once its layout is settled, by the layout it is left with. */
	const LAUNCH_FRAMES = {
		columns: ["heading: Launch", "slideColumn: Brief salesBook the room", "slideColumn: "],
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
				expect(framesOf(deck)[1]).toEqual(LAUNCH_FRAMES[layout]);
				expect(unfitted(deck)).toEqual([]);
			}
		},
	);
});

describe("a deck's slides, moved and removed", () => {
	it("moves a slide, keeping what it holds", () => {
		const { kim, sam } = twoPeople();

		const move = moveSlide(kim.state, 0, 1);
		if (!move) throw new Error("No move");
		kim.view.dispatch(move);

		expect(wordsOf(sam.state.doc)).toEqual([
			"People and botsPeople typeBots suggest",
			"GoalsShip on FridayTell support first",
		]);
		expect(moveSlide(kim.state, 1, 1)).toBeUndefined();
	});

	it("never removes a deck's last slide", () => {
		const { kim } = twoPeople();

		const removal = removeSlide(kim.state, 0);
		if (!removal) throw new Error("No removal");
		kim.view.dispatch(removal);

		expect(kim.state.doc.childCount).toBe(1);
		expect(removeSlide(kim.state, 0)).toBeUndefined();
	});
});
