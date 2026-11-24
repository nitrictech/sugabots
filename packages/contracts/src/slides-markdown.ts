/*
 * The markdown a `slides` deck is kept as, which bots read and write. Its
 * slides come one after another with a line of `---` between each two, a
 * blank line on either side of it. HTML comments say what markdown has no sign
 * for: a slide starts with its layout, as `<!-- layout: columns -->`; each of
 * the two columns of a slide laid out in columns starts with
 * `<!-- column -->`; and the speaker's notes end the slide, as
 * `<!-- notes: … -->`. The editor's schema reads and writes these (see
 * `live-slides.ts`).
 */

/** How a slide is laid out, which says what its frame holds. */
export const SLIDE_LAYOUTS = [
	"title",
	"bullets",
	"columns",
	"image",
	"section",
	"quote",
	"table",
] as const;
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

export const isSlideLayout = (value: unknown): value is SlideLayout =>
	(SLIDE_LAYOUTS as readonly unknown[]).includes(value);

/**
 * Whether a slide of `layout` holds two columns after its title. In `image`,
 * the second is where the image goes, which nothing enforces.
 */
export const layoutHasColumns = (layout: SlideLayout) => layout === "columns" || layout === "image";

/** What goes between two slides, with a blank line on either side. */
export const SLIDE_SEPARATOR = "---";

/** The comment a slide starts with, saying its layout. */
export const layoutComment = (layout: SlideLayout) => `<!-- layout: ${layout} -->`;

/** The comment each column of a slide starts with. */
export const COLUMN_COMMENT = "<!-- column -->";

/**
 * The comment holding a slide's notes, `markdown`: its paragraphs with a blank
 * line between each two. Words in markdown write `>` as `&gt;` already, but
 * code writes it as it is, and a `-->` would end the comment. So `-->` is
 * written `--\>`, and so that a `--\` already there isn't then read as one,
 * `--\` is written `--\\` first. `notesInComment` reads both back as they were.
 */
export const notesComment = (markdown: string) =>
	`<!-- notes: ${markdown.replaceAll("--\\", "--\\\\").replaceAll("-->", "--\\>")} -->`;

/** The notes `notesComment` wrote as `written`, as they were. */
const notesInComment = (written: string) =>
	written.replaceAll("--\\>", "-->").replaceAll("--\\\\", "--\\");

/** One of the comments a deck's markdown is written with. */
export type SlideComment =
	/** The layout as written, which may be none this version knows. */
	| { kind: "layout"; layout: string }
	| { kind: "column" }
	/** The notes' markdown: paragraphs with a blank line between each two. */
	| { kind: "notes"; markdown: string };

/**
 * The deck's comments `html` starts with, a piece of raw HTML in its
 * markdown, and what follows them: `undefined` when it starts with none. A
 * bot may write two on one line, or words after one, so all of them are read.
 */
export function readSlideComments(
	html: string,
): { comments: SlideComment[]; rest: string } | undefined {
	const comments: SlideComment[] = [];
	let rest = html;
	for (let match = COMMENT.exec(rest); match; match = COMMENT.exec(rest)) {
		const comment = slideComment(match[1] ?? "");
		if (!comment) break;
		comments.push(comment);
		rest = rest.slice(match[0].length);
	}
	return comments.length > 0 ? { comments, rest: rest.trim() } : undefined;
}

/** An HTML comment at the start of some text, with what it says. */
const COMMENT = /^\s*<!--([\s\S]*?)-->/;

/** What a comment says, when it is one of a deck's: forgiving of case, a missing colon and `columns` for `column`. */
function slideComment(said: string): SlideComment | undefined {
	const [, keyword, value = ""] =
		/^\s*(layout|columns?|notes)\b\s*:?\s*([\s\S]*?)\s*$/i.exec(said) ?? [];
	switch (keyword?.toLowerCase()) {
		case "layout":
			return { kind: "layout", layout: value.toLowerCase() };
		case "column":
		case "columns":
			return { kind: "column" };
		case "notes":
			return { kind: "notes", markdown: notesInComment(value) };
		default:
			return undefined;
	}
}
