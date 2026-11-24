import { type ArtifactImageType, imageTypeOf, MAX_ARTIFACT_IMAGE_BYTES } from "@sugabots/contracts";
import type { Editor } from "@tiptap/core";

/** Keeps an image for the document, answering the address the document shows it from. */
export type KeepImage = (image: { type: ArtifactImageType; bytes: Uint8Array }) => Promise<string>;

/** What an import of a Word file brought in. */
export interface WordImported {
	/**
	 * How many images in the file the document didn't keep: of a kind it can't
	 * show, larger than it keeps, or linked from outside the file.
	 */
	imagesLeftOut: number;
}

/**
 * An image in the Word file couldn't be kept, as when the API couldn't be
 * reached or refused it, so nothing was imported. `cause` is why.
 */
export class ImageNotKept extends Error {
	constructor(cause: unknown) {
		super("An image in the Word file could not be kept", { cause });
		this.name = "ImageNotKept";
	}
}

/**
 * Replaces the editor's document, for everyone in it, with a Word file's
 * content, keeping each image in it with `keepImage`. Whatever the file holds
 * that the document can't, such as a text box, a colour or an image of a kind
 * it can't show, is left out, keeping its words where it has any. Fails,
 * changing nothing, when the file can't be read, or with `ImageNotKept` when
 * an image the document would keep couldn't be: importing without it would
 * take it from the document for everyone.
 */
export async function importWordFile(
	editor: Editor,
	file: File,
	keepImage: KeepImage,
): Promise<WordImported> {
	const { convertToHtml, images } = await import("mammoth");
	const kept = new Set<string>();
	let imagesLeftOut = 0;
	const notKept: ImageNotKept[] = [];
	const { value } = await convertToHtml(
		{ arrayBuffer: await withHorizontalLinesAsPageBreaks(await file.arrayBuffer()) },
		{
			styleMap: WORD_STYLES,
			convertImage: images.imgElement(async (image) => {
				// Mammoth converts images one after another, and once one isn't kept nothing is imported.
				if (notKept.length > 0) return { src: "" };
				const keepable = await keepableImage(image);
				if (!keepable) {
					imagesLeftOut++;
					return { src: "" };
				}
				try {
					const address = await keepImage(keepable);
					kept.add(address);
					return { src: address };
				} catch (failure) {
					notKept.push(new ImageNotKept(failure));
					return { src: "" };
				}
			}),
		},
	);
	// Mammoth leaves out an image its converter fails on and carries on, so the failure is raised here.
	const [failed] = notKept;
	if (failed) throw failed;
	const page = new DOMParser().parseFromString(value, "text/html");
	giveTablesHeaderRows(page);
	removeImagesNotKept(page, kept);
	removeEmptyParagraphs(page);
	// The parser keeps what the document's schema holds and unwraps any element
	// it has no rule for to its words, so what it makes is content the schema
	// holds. Checking for content it can't hold, as the editor does with what
	// others write, would refuse the whole file over one such element.
	editor.commands.setContent(page.body.innerHTML, { errorOnInvalidContent: false });
	return { imagesLeftOut };
}

/**
 * What of a Word file's formatting is read beyond what mammoth reads by
 * itself: underline and highlight, a page break as a divider (a horizontal
 * line is made one first, see `withHorizontalLinesAsPageBreaks`), and Word's
 * own styles for a title, quotes and code as a heading, block quotes and code.
 */
const WORD_STYLES = [
	"u => u",
	"highlight => mark",
	"br[type='page'] => hr",
	"p[style-name='Title'] => h1:fresh",
	"p[style-name='Quote'] => blockquote > p:fresh",
	"p[style-name='Intense Quote'] => blockquote > p:fresh",
	"r[style-name='HTML Code'] => code",
	// One code block for a run of its paragraphs, a line each.
	"p[style-name='HTML Preformatted'] => pre:separator('\\n')",
];

/**
 * `file` with each horizontal line in it made a page break, which the import
 * reads as a divider: mammoth reads no line, as Word writes one. Two kinds
 * are made: the line Word draws for its Horizontal Line, which other word
 * processors write too, and an empty paragraph with a border along its
 * bottom, which Word makes of three typed hyphens. A border under a paragraph
 * with words in it is left alone, as it may underline a heading rather than
 * divide the page. A file that can't be read so is imported as it is.
 */
async function withHorizontalLinesAsPageBreaks(file: ArrayBuffer): Promise<ArrayBuffer> {
	try {
		const { default: JSZip } = await import("jszip");
		const zip = await JSZip.loadAsync(file);
		const body = zip.file(DOCUMENT_PART);
		if (!body) return file;
		const xml = await body.async("string");
		const prepared = pageBreaksForHorizontalLines(xml);
		if (prepared === xml) return file;
		zip.file(DOCUMENT_PART, prepared);
		return await zip.generateAsync({ type: "arraybuffer" });
	} catch {
		// Mammoth reads the file as it is, or says it can't.
		return file;
	}
}

/** Where a .docx keeps its body. */
const DOCUMENT_PART = "word/document.xml";

const PAGE_BREAK = '<w:br w:type="page"/>';

/** A picture drawn in the shapes Word wrote before its own drawings, each closed where it opens. */
const VML_PICTURE = /<w:pict(?:\s[^>]*[^/>])?>[\s\S]*?<\/w:pict>/g;

/** What marks a shape as a horizontal line. */
const HORIZONTAL_LINE_SHAPE = /\so:hr=["'](?:t|true)["']/;

/**
 * A paragraph, from its opening to the first closing after it. One holding
 * another, as a text box's does, is cut short at the inner one's closing.
 */
const PARAGRAPH = /<w:p(?:\s[^>]*[^/>])?>[\s\S]*?<\/w:p>/g;

/** A border along a paragraph's bottom that is drawn, not one turned off. */
const BOTTOM_BORDER =
	/<w:pBdr>(?:(?!<\/w:pBdr>)[\s\S])*<w:bottom\b(?![^>]*w:val=["'](?:none|nil)["'])/;

/** What makes a paragraph more than a line: words, a picture, an object, or another paragraph within. */
const MORE_THAN_A_LINE = /<w:t[\s>]|<w:drawing|<w:pict|<w:object|<w:p[\s>]/;

function pageBreaksForHorizontalLines(xml: string): string {
	return xml
		.replace(VML_PICTURE, (picture) => (HORIZONTAL_LINE_SHAPE.test(picture) ? PAGE_BREAK : picture))
		.replace(PARAGRAPH, (paragraph) => {
			const typedLine =
				BOTTOM_BORDER.test(paragraph) && !MORE_THAN_A_LINE.test(paragraph.slice("<w:p".length));
			return typedLine ? `<w:p><w:r>${PAGE_BREAK}</w:r></w:p>` : paragraph;
		});
}

/**
 * An image in the file as the document would keep it, as the kind its bytes
 * are, whatever the file says it is, or `undefined` for one it doesn't keep:
 * of a kind it can't show, such as a Windows metafile, larger than it keeps,
 * or linked from outside the file, which can't be read.
 */
async function keepableImage(image: {
	readAsArrayBuffer: () => Promise<ArrayBuffer>;
}): Promise<{ type: ArtifactImageType; bytes: Uint8Array } | undefined> {
	const bytes = await image.readAsArrayBuffer().then(
		(read) => new Uint8Array(read),
		() => undefined,
	);
	if (!bytes || bytes.byteLength > MAX_ARTIFACT_IMAGE_BYTES) return undefined;
	const type = imageTypeOf(bytes);
	return type && { type, bytes };
}

/**
 * Makes the first row of each table without a header row its header row.
 * The document is kept as markdown, whose tables all have one, so a table
 * without would otherwise gain an empty row the first time it is written.
 */
function giveTablesHeaderRows(page: Document): void {
	for (const table of page.querySelectorAll("table")) {
		const firstRow = table.querySelector("tr");
		if (!firstRow || firstRow.querySelector(":scope > th")) continue;
		for (const cell of firstRow.querySelectorAll(":scope > td")) {
			const header = page.createElement("th");
			for (const { name, value } of cell.attributes) header.setAttribute(name, value);
			header.append(...cell.childNodes);
			cell.replaceWith(header);
		}
	}
}

/** Removes every image the document didn't keep, which has no address of `kept` to show it from. */
function removeImagesNotKept(page: Document, kept: ReadonlySet<string>): void {
	for (const image of page.querySelectorAll("img")) {
		if (!kept.has(image.getAttribute("src") ?? "")) image.remove();
	}
}

/**
 * Removes the empty paragraphs left once the file is read. Mammoth puts the
 * divider a page break becomes inside a paragraph, which HTML closes before
 * the divider, leaving an empty paragraph on either side of it; and a
 * paragraph that held only an image the document didn't keep is empty too.
 * Mammoth leaves out the file's own empty paragraphs, so no others are lost.
 */
function removeEmptyParagraphs(page: Document): void {
	for (const paragraph of page.querySelectorAll("p:empty")) paragraph.remove();
}
