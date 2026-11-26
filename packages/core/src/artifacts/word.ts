import { randomUUID } from "node:crypto";
import {
	type Artifact,
	type ArtifactImageType,
	MAX_ARTIFACT_IMAGES_BYTES,
} from "@sugabots/contracts";
import { allowedHtmlTag } from "@sugabots/contracts/document-markdown";
import { type ArtifactImageIds, ownImageAt } from "@sugabots/contracts/http";
import { markdownOfLiveDocument } from "@sugabots/contracts/live-document-markdown";
import type { Node } from "@tiptap/pm/model";
import htmlToDocx from "@turbodocx/html-to-docx";
import { Effect } from "effect";
import JSZip from "jszip";
import { Marked, type Parser, type Token, type Tokens } from "marked";

/** The media type of a .docx file. */
export const WORD_CONTENT_TYPE =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** An image for the Word file to hold: its bytes, and their media type. */
export interface WordImage {
	contentType: ArtifactImageType;
	bytes: Uint8Array;
}

/**
 * `document`, a `document` artifact as people see it, as a Word file titled
 * as the artifact is, made from its markdown: headings, lists, quotes, links,
 * code, tables and dividers as Word's own, in Word's default styles, with
 * underline, superscript, subscript and highlight. An image the artifact
 * keeps is held in the file, as `imageOf` gives it, whichever kind it is,
 * inside its link when it has one. Word shows a PNG, JPEG or GIF; a WebP only
 * where that version of Word reads WebP. Any other image, and raw HTML but
 * for the tags the editor writes, come out as their text. A code block's
 * language is lost, as Word keeps none for code.
 */
export const wordFileOf = <E, R>(
	artifact: Pick<Artifact, "podId" | "id" | "title">,
	document: Node,
	imageOf: (image: ArtifactImageIds) => Effect.Effect<WordImage | undefined, E, R>,
): Effect.Effect<Uint8Array, E, R> =>
	Effect.gen(function* () {
		const tokens = new Marked().lexer(markdownOfLiveDocument(document));
		const own = ownImagesIn(tokens, { podId: artifact.podId, artifactId: artifact.id });
		const found = yield* Effect.forEach(own, ([address, ids]) =>
			Effect.map(imageOf(ids), (image) => [address, image] as const),
		);
		const inlined = new Map(
			found.flatMap(([address, image]) => (image ? [[address, image] as const] : [])),
		);
		const markers: Markers = {
			divider: randomUUID(),
			quote: randomUUID(),
			header: randomUUID(),
			inlineCode: randomUUID(),
			codeLine: randomUUID(),
		};
		const html = htmlConverting(inlined, markers).parser(tokens);
		return yield* Effect.promise(async () => {
			const file = await htmlToDocx(html, null, { title: artifact.title });
			return withWordsOwnForms(file instanceof Blob ? await file.arrayBuffer() : file, markers);
		});
	});

/**
 * Text the converter is handed in what it can't mark as Word would, to find
 * in the file it writes and mark there: in the paragraph a divider becomes,
 * in each paragraph of a quote, in each cell of a header row, in each piece
 * of inline code, and in each line of a code block. Fresh for each file, so
 * no document's own text is taken for one.
 */
interface Markers {
	divider: string;
	quote: string;
	header: string;
	inlineCode: string;
	codeLine: string;
}

/** The images in the markdown that `artifact` keeps, once each, by address. */
function ownImagesIn(
	tokens: Token[],
	artifact: { podId: string; artifactId: string },
): [string, ArtifactImageIds][] {
	const own = new Map<string, ArtifactImageIds>();
	new Marked().walkTokens(tokens, (token) => {
		if (token.type !== "image") return;
		const ids = ownImageAt(token.href, artifact);
		if (ids) own.set(token.href, ids);
	});
	return [...own];
}

/**
 * The kinds of image the converter holds in the file it writes without
 * declaring them, by the extension it names each one's part with. A part of
 * no declared kind is one Word may take for damage and mammoth reads as no
 * kind of image, so `withWordsOwnForms` declares them.
 */
const UNDECLARED_IMAGE_TYPES: Readonly<Record<string, ArtifactImageType>> = {
	gif: "image/gif",
	webp: "image/webp",
};

/*
 * The converter fetches whatever an `<img>` points at, from this process. A
 * document's markdown is written by the pod's bots and people, so an image or
 * raw HTML in it must not become a request the API makes: only an image in
 * `inlined`, whose bytes are already here, is drawn as one. Each time one is
 * drawn counts against the most a document keeps of images, so an image
 * written many times can't make the file hold more than that.
 *
 * Some of what the document holds the converter can't write as Word does,
 * so it is handed what `withWordsOwnForms` then makes Word's own (see
 * `Markers`): a highlight as yellow shading, as the converter writes no
 * highlight for `<mark>`; a divider as a paragraph holding only its marker,
 * as it writes no line for `<hr>`; a quote as paragraphs marked for Word's
 * Quote style, as it writes a quote as an indented paragraph; a header row
 * marked as one, as it marks no row a header; inline code marked, as it
 * writes `<code>` as plain text; and a code block as a marked `<pre>` for
 * each line, as it writes a block as one paragraph whose lines Word would
 * run together. The converter keeps a `<pre>`'s spaces and tabs as they are.
 * The header row is also bold: the converter's tables have no style that
 * would set it apart, so without bold it would look like any other row.
 *
 * Each cell's content is put in a paragraph, as the converter makes a
 * paragraph of each piece of a cell's text that is formatted differently,
 * such as bold or code, unless the cell holds a paragraph.
 */
function htmlConverting(inlined: ReadonlyMap<string, WordImage>, markers: Markers): Marked {
	let imageBytesLeft = MAX_ARTIFACT_IMAGES_BYTES;
	return new Marked({
		renderer: {
			image: ({ href, text }) => {
				const image = inlined.get(href);
				if (!image || image.bytes.byteLength > imageBytesLeft) return escapeHtml(text);
				imageBytesLeft -= image.bytes.byteLength;
				return `<img src="${dataAddress(image)}" alt="${escapeHtml(text)}">`;
			},
			html: ({ text }) => {
				const tag = allowedHtmlTag(text);
				if (!tag) return escapeHtml(text);
				if (tag.name !== "mark") return text;
				return tag.closing
					? "</span>"
					: `<span style="background-color: ${WORD_HIGHLIGHT_YELLOW}">`;
			},
			hr: () => `<p>${markers.divider}</p>\n`,
			blockquote({ tokens }) {
				return quoted(this.parser, tokens, markers.quote);
			},
			codespan: ({ text }) => `<code>${markers.inlineCode}${escapeHtml(text)}</code>`,
			code: ({ text }) =>
				text
					.split("\n")
					.map((line) => `<pre>${markers.codeLine}${escapeHtml(line)}</pre>\n`)
					.join(""),
			tablecell(cell) {
				const align = cell.align ? ` align="${cell.align}"` : "";
				const content = this.parser.parseInline(cell.tokens);
				return cell.header
					? `<th${align}><p><strong>${markers.header}${content}</strong></p></th>\n`
					: `<td${align}><p>${content}</p></td>\n`;
			},
		},
	});
}

/**
 * A quote's blocks as HTML: each paragraph marked with `marker` to be one in
 * Word's Quote style, a quote within the quote's included, and any other
 * block, such as a list or code, as it is. Word's Quote style is a
 * paragraph's, so a list in a quote stands as a list between the quote's
 * paragraphs, and code as code.
 */
function quoted(parser: Parser, tokens: readonly Token[], marker: string): string {
	return tokens
		.map((token) => {
			if (token.type === "paragraph") {
				return `<p>${marker}${parser.parseInline((token as Tokens.Paragraph).tokens)}</p>\n`;
			}
			if (token.type === "blockquote") {
				return quoted(parser, (token as Tokens.Blockquote).tokens, marker);
			}
			return parser.parse([token]);
		})
		.join("");
}

/** The yellow a highlight is shaded with on its way through the converter, Word's own highlight colour. */
const WORD_HIGHLIGHT_YELLOW = "#ffff00";

/** The image as an address that holds its bytes, which the converter reads without fetching anything. */
const dataAddress = ({ contentType, bytes }: WordImage) =>
	`data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;

/**
 * `file` with what the converter can't write made as Word writes it, so Word
 * and anything else reading the file, the import among them, take it for
 * what it is: each divider's paragraph made the horizontal line Word draws
 * for its own Horizontal Line, which other word processors write too; each
 * quote's paragraphs put in Word's Quote style; each header row marked as
 * one, which Word repeats on each page the table runs onto; inline code put
 * in Word's HTML Code style, and each line of a code block in its HTML
 * Preformatted style, which the file then defines; each highlight's shading
 * made Word's highlight, which its highlight button knows, as it doesn't
 * shading; each image's words put where Word reads them; and each kind of
 * image it holds declared.
 */
async function withWordsOwnForms(
	file: ArrayBuffer | Uint8Array,
	markers: Markers,
): Promise<Uint8Array> {
	const zip = await JSZip.loadAsync(file);
	const body = zip.file(DOCUMENT_PART);
	const contentTypes = zip.file(CONTENT_TYPES_PART);
	if (!body || !contentTypes) return new Uint8Array(file);
	const [xml, types] = await Promise.all([body.async("string"), contentTypes.async("string")]);
	const declared = withImageTypesDeclared(types, Object.keys(zip.files));
	const rewritten = [
		(within: string) => elementsHolding(within, markers.divider, "w:p", () => HORIZONTAL_LINE),
		(within: string) => elementsHolding(within, markers.quote, "w:p", inQuoteStyle),
		(within: string) => elementsHolding(within, markers.header, "w:tr", asHeaderRow),
		(within: string) => elementsHolding(within, markers.inlineCode, "w:r", inCodeStyle),
		(within: string) => elementsHolding(within, markers.codeLine, "w:p", asCodeLine),
		highlightsForShading,
		imageWordsWhereWordReadsThem,
	].reduce((within, change) => change(within), xml);
	if (rewritten === xml && declared === types) return new Uint8Array(file);
	zip.file(DOCUMENT_PART, rewritten);
	zip.file(CONTENT_TYPES_PART, declared);
	const styles = zip.file(STYLES_PART);
	if (styles) zip.file(STYLES_PART, withWordsOwnStyles(await styles.async("string"), rewritten));
	return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** Where a .docx keeps its body, its styles, and the kind of each of its parts. */
const DOCUMENT_PART = "word/document.xml";
const STYLES_PART = "word/styles.xml";
const CONTENT_TYPES_PART = "[Content_Types].xml";

/** `contentTypes`, a file's kinds of part, declaring each kind of image among `parts` that it doesn't. */
function withImageTypesDeclared(contentTypes: string, parts: readonly string[]): string {
	const declarations = Object.entries(UNDECLARED_IMAGE_TYPES)
		.filter(
			([extension]) =>
				parts.some((part) => part.toLowerCase().endsWith(`.${extension}`)) &&
				!contentTypes.includes(`Extension="${extension}"`),
		)
		.map(([extension, type]) => `<Default Extension="${extension}" ContentType="${type}"/>`);
	if (declarations.length === 0) return contentTypes;
	return contentTypes.replace("</Types>", `${declarations.join("")}</Types>`);
}

/**
 * `xml` with each `tag` element that holds `marker` changed by `change`, the
 * marker taken out first. The converter writes none of these elements
 * within another of its kind, so the nearest of its openings before a marker
 * and of its closings after it are one element's. A marker with no such
 * element around it is only taken out.
 */
function elementsHolding(
	xml: string,
	marker: string,
	tag: "w:p" | "w:r" | "w:tr",
	change: (element: string) => string,
): string {
	let result = xml;
	for (let at = result.indexOf(marker); at !== -1; at = result.indexOf(marker, at)) {
		const start = Math.max(result.lastIndexOf(`<${tag}>`, at), result.lastIndexOf(`<${tag} `, at));
		const closing = result.indexOf(`</${tag}>`, at);
		if (start === -1 || closing === -1) {
			result = result.slice(0, at) + result.slice(at + marker.length);
			continue;
		}
		const end = closing + `</${tag}>`.length;
		const changed = change(result.slice(start, end).replaceAll(marker, ""));
		result = result.slice(0, start) + changed + result.slice(end);
		at = start + changed.length;
	}
	return result;
}

/**
 * `element`, a paragraph, run or row, with `property` first among its
 * properties: where Word's schema puts a paragraph's or run's style, and
 * where any of a row's properties may go.
 */
function withFirstProperty(element: string, tag: "p" | "r" | "tr", property: string): string {
	const properties = `w:${tag}Pr`;
	if (element.includes(`<${properties}/>`)) {
		return element.replace(`<${properties}/>`, `<${properties}>${property}</${properties}>`);
	}
	if (element.includes(`<${properties}>`)) {
		return element.replace(`<${properties}>`, `<${properties}>${property}`);
	}
	return element.replace(
		new RegExp(`^<w:${tag}(\\s[^>]*)?>`),
		(opening) => `${opening}<${properties}>${property}</${properties}>`,
	);
}

const IN_QUOTE_STYLE = '<w:pStyle w:val="Quote"/>';

const inQuoteStyle = (paragraph: string) => withFirstProperty(paragraph, "p", IN_QUOTE_STYLE);

const HEADER_ROW = "<w:tblHeader/>";

const asHeaderRow = (row: string) => withFirstProperty(row, "tr", HEADER_ROW);

const IN_CODE_STYLE = '<w:rStyle w:val="HTMLCode"/>';

/** A run's character style, such as the one the converter gives a link's text. */
const RUN_STYLE = /<w:rStyle\s[^>]*\/>/;

/**
 * The run in Word's HTML Code style. A run has one character style, so code
 * in a link takes the place of the link's: the link is kept, without its
 * colour and underline.
 */
const inCodeStyle = (run: string) =>
	withFirstProperty(run.replace(RUN_STYLE, ""), "r", IN_CODE_STYLE);

const IN_PREFORMATTED_STYLE = '<w:pStyle w:val="HTMLPreformatted"/>';

/** The font the converter gives a `<pre>`'s text, which would hide the style's. */
const PREFORMATTED_FONT = '<w:rFonts w:ascii="Courier" w:hAnsi="Courier"/>';

/** Text that keeps its spaces, as the converter writes all of it. */
const PRESERVED_TEXT = /<w:t xml:space="preserve">([^<]*)<\/w:t>/g;

/**
 * The paragraph a line of code is written as, in Word's HTML Preformatted
 * style, which gives it its font, with each tab in it written as Word
 * writes one.
 */
function asCodeLine(paragraph: string): string {
	const tabbed = paragraph
		.replaceAll(PREFORMATTED_FONT, "")
		.replace(PRESERVED_TEXT, (_text, inside: string) =>
			inside
				.split("\t")
				.map((part) => `<w:t xml:space="preserve">${part}</w:t>`)
				.join("<w:tab/>"),
		);
	return withFirstProperty(tabbed, "p", IN_PREFORMATTED_STYLE);
}

/**
 * Word's own styles the file's paragraphs and runs are put in, by their
 * built-in ids and names, so Word takes them for its own, with the look Word
 * gives them: Quote centred and indented in grey italics, and the code styles
 * in a monospace font. The converter's styles define none of them.
 */
const WORDS_OWN_STYLES = [
	{
		id: "Quote",
		usedAs: IN_QUOTE_STYLE,
		definition:
			'<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/><w:pPr><w:spacing w:before="200" w:after="160"/><w:ind w:left="864" w:right="864"/><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="404040"/></w:rPr></w:style>',
	},
	{
		id: "HTMLCode",
		usedAs: IN_CODE_STYLE,
		definition:
			'<w:style w:type="character" w:styleId="HTMLCode"><w:name w:val="HTML Code"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>',
	},
	{
		id: "HTMLPreformatted",
		usedAs: IN_PREFORMATTED_STYLE,
		definition:
			'<w:style w:type="paragraph" w:styleId="HTMLPreformatted"><w:name w:val="HTML Preformatted"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>',
	},
];

/** `styles`, a file's styles, defining each of Word's own that `document` uses and they don't. */
function withWordsOwnStyles(styles: string, document: string): string {
	const missing = WORDS_OWN_STYLES.filter(
		({ id, usedAs }) => document.includes(usedAs) && !styles.includes(`w:styleId="${id}"`),
	);
	if (missing.length === 0) return styles;
	const definitions = missing.map(({ definition }) => definition).join("");
	return styles.replace("</w:styles>", `${definitions}</w:styles>`);
}

/** The shading the converter writes in a run's properties for a highlight's `WORD_HIGHLIGHT_YELLOW`. */
const HIGHLIGHT_SHADING = '<w:shd w:val="clear" w:fill="ffff00"/>';

const WORD_HIGHLIGHT = '<w:highlight w:val="yellow"/>';

/**
 * The properties a run may hold that Word's schema puts after its highlight,
 * in that order: it reads a run's properties in a fixed order, and the
 * converter writes shading after underline, so the highlight can't simply
 * take the shading's place.
 */
const AFTER_HIGHLIGHT = new Set([
	"u",
	"effect",
	"bdr",
	"shd",
	"fitText",
	"vertAlign",
	"rtl",
	"cs",
	"em",
	"lang",
	"eastAsianLayout",
	"specVanish",
	"oMath",
	"rPrChange",
]);

/**
 * `xml` with each run's highlight shading replaced by Word's highlight, put
 * where the schema wants it among the run's other properties.
 *
 * Only a highlight puts shading in a run's properties: raw HTML in the
 * markdown reaches the converter as its text (see `htmlConverting`), and
 * nothing else it is handed sets a background, so no shading of anyone
 * else's is turned into a highlight.
 */
function highlightsForShading(xml: string): string {
	return xml.replace(/<w:rPr>([\s\S]*?)<\/w:rPr>/g, (properties, inside: string) => {
		if (!inside.includes(HIGHLIGHT_SHADING)) return properties;
		const rest = inside.replace(HIGHLIGHT_SHADING, "");
		const later = [...rest.matchAll(/<w:(\w+)/g)].find(([, name]) =>
			AFTER_HIGHLIGHT.has(name ?? ""),
		);
		const at = later?.index ?? rest.length;
		return `<w:rPr>${rest.slice(0, at)}${WORD_HIGHLIGHT}${rest.slice(at)}</w:rPr>`;
	});
}

/** A picture's words, as the converter writes them on the picture itself. */
const PICTURE_WORDS = /<pic:cNvPr\s[^>]*?\bdescr="([^"]*)"/;

/** A drawing's properties, which hold the words Word shows for it, without any yet. */
const DRAWING_PROPERTIES = /<wp:docPr\b(?![^>]*\bdescr=)([^>]*?)(\/?)>/;

/**
 * `xml` with each drawing's words, an image's alt text, on its properties
 * (`wp:docPr`), where Word and mammoth read them: the converter writes them
 * only on the picture inside it. They are copied as the converter escaped
 * them, but for a line break or tab, which an attribute keeps only as a
 * character reference, its reader taking a bare one for a space. A drawing
 * with no words is given none, as Word gives none.
 */
function imageWordsWhereWordReadsThem(xml: string): string {
	return xml.replace(/<w:drawing>[\s\S]*?<\/w:drawing>/g, (drawing) => {
		const words = PICTURE_WORDS.exec(drawing)?.[1];
		if (!words) return drawing;
		const kept = words.replace(/[\t\n\r]/g, (character) => `&#${character.charCodeAt(0)};`);
		return drawing.replace(
			DRAWING_PROPERTIES,
			(_properties, attributes: string, closing: string) =>
				`<wp:docPr${attributes} descr="${kept}"${closing}>`,
		);
	});
}

const HORIZONTAL_LINE =
	'<w:p><w:r><w:pict><v:rect style="width:0.0pt;height:1.5pt" o:hr="t" o:hrstd="t" o:hralign="center" fillcolor="#A0A0A0" stroked="f"/></w:pict></w:r></w:p>';

const escapeHtml = (text: string) =>
	text.replace(/[&<>"]/g, (character) => HTML_ENTITIES[character] ?? character);

const HTML_ENTITIES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
};
