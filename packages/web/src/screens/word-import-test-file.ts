import { deflateSync } from "node:zlib";
import {
	AlignmentType,
	BorderStyle,
	Document,
	ExternalHyperlink,
	Footer,
	Header,
	HeadingLevel,
	ImageRun,
	LevelFormat,
	Packer,
	PageBreak,
	PageNumber,
	Paragraph,
	ShadingType,
	Table,
	TableCell,
	TableRow,
	TextRun,
	WidthType,
} from "docx";
import JSZip from "jszip";

/*
 * The Word file `live-document.test.tsx` imports: a section for each kind of
 * thing a Word file holds, each saying what it holds, and a page header and
 * footer the import must leave out.
 */

/**
 * The file, with its first image as a PNG, as a BMP, a kind of image a
 * document doesn't keep, or as a GIF the file says is a PNG. A GIF and an
 * image inside a link to `LINKED_IMAGE_LINK` follow it.
 */
export async function wordImportTestFile({
	image = "png",
}: {
	image?: TestImage;
} = {}): Promise<File> {
	const bytes = await Packer.toBuffer(testDocument(TEST_IMAGES[image]()));
	return new File([await withHorizontalLine(bytes)], "word-import-test.docx");
}

type TestImage = keyof typeof TEST_IMAGES;

/** An image in the file: what the file says it is, and its bytes. */
interface Picture {
	type: "png" | "gif" | "bmp";
	data: Buffer;
}

/** The file's first image. */
const TEST_IMAGES = {
	png: () => ({ type: "png", data: png(320, 120, [47, 111, 235]) }),
	bmp: () => ({ type: "bmp", data: ONE_PIXEL_BMP }),
	"gif called png": () => ({ type: "png", data: ONE_PIXEL_GIF }),
} satisfies Record<string, () => Picture>;

/** Where the file's linked image links to. */
export const LINKED_IMAGE_LINK = "https://example.com/picture";

/** An image of the file, drawn at `size`, with `description` as the words that say what it shows. */
const picture = (
	{ type, data }: Picture,
	description: string,
	size: { width: number; height: number },
) =>
	new ImageRun({
		type,
		data,
		transformation: size,
		altText: { title: description, description, name: description },
	});

/** Stands in the file for the horizontal line `withHorizontalLine` draws, which `docx` can't. */
const HORIZONTAL_LINE_HERE = "HORIZONTAL LINE HERE";

/** The horizontal line Word draws for its own Horizontal Line, which Google Docs writes too. */
const HORIZONTAL_LINE =
	'<w:p><w:r><w:pict><v:rect style="width:0;height:1.5pt" o:hralign="center" o:hrstd="t" o:hr="t" fillcolor="#a0a0a0" stroked="f"/></w:pict></w:r></w:p>';

/** `file` with the paragraph holding `HORIZONTAL_LINE_HERE` made a horizontal line. */
async function withHorizontalLine(file: Uint8Array): Promise<ArrayBuffer> {
	const zip = await JSZip.loadAsync(file);
	const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
	const at = xml.indexOf(HORIZONTAL_LINE_HERE);
	const start = xml.lastIndexOf("<w:p>", at);
	const end = xml.indexOf("</w:p>", at) + "</w:p>".length;
	zip.file("word/document.xml", xml.slice(0, start) + HORIZONTAL_LINE + xml.slice(end));
	return zip.generateAsync({ type: "arraybuffer" });
}

const FONT = "Calibri";

/** The lines of the file's code block: one indented, one with characters that matter to HTML. */
const CODE_LINES = [
	"function greet(name) {",
	'  if (name && name.length < 40) return "<b>" + name;',
	"}",
];

/** A plain PNG of one colour, so the file carries a real embedded image. */
function png(width: number, height: number, [red, green, blue]: [number, number, number]) {
	const row = Buffer.alloc(1 + width * 3);
	for (let x = 0; x < width; x++) row.set([red, green, blue], 1 + x * 3);
	const pixels = Buffer.concat(Array.from({ length: height }, () => row));
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (bytes: Buffer) => {
		let c = 0xffffffff;
		for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([length, body, sum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(pixels)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** A one-pixel blue BMP, a kind of image a document doesn't keep. */
const ONE_PIXEL_BMP = Buffer.from(
	"Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAA628vAA==",
	"base64",
);

/** A one-pixel GIF. */
const ONE_PIXEL_GIF = Buffer.from(
	"R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
	"base64",
);

type Marks = Omit<ConstructorParameters<typeof TextRun>[0] & object, "text">;

const text = (value: string, marks: Marks = {}) =>
	new TextRun({ text: value, font: FONT, ...marks });
const body = (...runs: (string | TextRun | ExternalHyperlink)[]) =>
	new Paragraph({
		spacing: { after: 160 },
		children: runs.map((run) => (typeof run === "string" ? text(run) : run)),
	});
const heading = (level: (typeof HeadingLevel)[keyof typeof HeadingLevel], value: string) =>
	new Paragraph({ heading: level, children: [text(value)] });
const bullet = (value: string, level = 0) =>
	new Paragraph({ numbering: { reference: "bullets", level }, children: [text(value)] });
const numbered = (value: string, level = 0) =>
	new Paragraph({ numbering: { reference: "steps", level }, children: [text(value)] });

const COLUMN_WIDTHS = [2600, 3160, 3600];
const cell = (value: string, width: number, header = false) =>
	new TableCell({
		width: { size: width, type: WidthType.DXA },
		margins: { top: 80, bottom: 80, left: 120, right: 120 },
		...(header ? { shading: { type: ShadingType.CLEAR, fill: "E8EEF7", color: "auto" } } : {}),
		children: [new Paragraph({ children: [text(value, { bold: header })] })],
	});
const row = (values: string[], header = false) =>
	new TableRow({
		...(header ? { tableHeader: true } : {}),
		children: values.map((value, index) => cell(value, COLUMN_WIDTHS[index] ?? 0, header)),
	});

const headingStyle = (size: number) => ({
	run: { font: FONT, size, bold: true },
	paragraph: { spacing: { before: 280, after: 120 }, keepNext: true },
});
const listLevels = (format: (typeof LevelFormat)[keyof typeof LevelFormat], texts: string[]) =>
	texts.map((levelText, level) => ({
		level,
		format,
		text: levelText,
		alignment: AlignmentType.LEFT,
		style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
	}));

function testDocument(image: Picture): Document {
	return new Document({
		creator: "Import test",
		title: "Word import test",
		styles: {
			default: {
				document: { run: { font: FONT, size: 22 } },
				title: {
					run: { font: FONT, size: 52, bold: true },
					paragraph: { spacing: { before: 0, after: 200 }, keepNext: true },
				},
				heading1: headingStyle(34),
				heading2: headingStyle(28),
				heading3: headingStyle(24),
			},
			paragraphStyles: [
				{
					id: "Quote",
					name: "Quote",
					basedOn: "Normal",
					run: { italics: true, color: "555555" },
					paragraph: { indent: { left: 720 }, spacing: { after: 160 } },
				},
				{
					id: "HTMLPreformatted",
					name: "HTML Preformatted",
					basedOn: "Normal",
					run: { font: "Courier New", size: 20 },
					paragraph: { spacing: { after: 0 } },
				},
			],
			characterStyles: [
				{ id: "HTMLCode", name: "HTML Code", run: { font: "Courier New", size: 20 } },
			],
		},
		numbering: {
			config: [
				{ reference: "bullets", levels: listLevels(LevelFormat.BULLET, ["•", "◦"]) },
				{ reference: "steps", levels: listLevels(LevelFormat.DECIMAL, ["%1.", "%2."]) },
			],
		},
		sections: [
			{
				properties: {
					page: {
						size: { width: 12240, height: 15840 },
						margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
					},
				},
				headers: {
					default: new Header({
						children: [new Paragraph({ children: [text("PAGE HEADER: should not be imported")] })],
					}),
				},
				footers: {
					default: new Footer({
						children: [
							new Paragraph({
								alignment: AlignmentType.CENTER,
								children: [
									text("PAGE FOOTER: should not be imported. Page "),
									new TextRun({ children: [PageNumber.CURRENT], font: FONT }),
								],
							}),
						],
					}),
				},
				children: [
					new Paragraph({ heading: HeadingLevel.TITLE, children: [text("Word import test")] }),
					body(
						"Each section below says what it holds, so anything missing or changed after the import is easy to spot.",
					),

					heading(HeadingLevel.HEADING_1, "1. Text formatting"),
					body(
						"This sentence has ",
						text("bold", { bold: true }),
						", ",
						text("italic", { italics: true }),
						", ",
						text("underlined", { underline: {} }),
						", ",
						text("struck through", { strike: true }),
						" and ",
						text("bold italic together", { bold: true, italics: true }),
						".",
					),
					body(
						"Formatting the editor has no mark for: ",
						text("red text", { color: "C00000" }),
						", ",
						text("highlighted text", { highlight: "yellow" }),
						", ",
						text("large text", { size: 36 }),
						", x",
						text("2", { superScript: true }),
						" and H",
						text("2", { subScript: true }),
						"O.",
					),
					body(
						"A link: ",
						new ExternalHyperlink({
							link: "https://example.com/launch-plan",
							children: [text("the launch plan", { style: "Hyperlink" })],
						}),
						". Punctuation that often breaks: “curly quotes”, an en dash (2024–2026), an ellipsis… and accents (café, naïve, Zürich).",
					),

					heading(HeadingLevel.HEADING_1, "2. Headings"),
					body("A heading 2 and a heading 3 follow."),
					heading(HeadingLevel.HEADING_2, "2.1 A second-level heading"),
					body("Text under the second-level heading."),
					heading(HeadingLevel.HEADING_3, "2.1.1 A third-level heading"),
					body("Text under the third-level heading."),

					heading(HeadingLevel.HEADING_1, "3. Lists"),
					body("A bulleted list with one nested level:"),
					bullet("First bullet"),
					bullet("Second bullet"),
					bullet("Nested under the second", 1),
					bullet("Also nested", 1),
					bullet("Third bullet"),
					body("A numbered list with one nested level:"),
					numbered("Write the announcement"),
					numbered("Review it"),
					numbered("With legal", 1),
					numbered("With support", 1),
					numbered("Publish"),

					heading(HeadingLevel.HEADING_1, "4. Quote"),
					body("The next paragraph uses Word's Quote style:"),
					new Paragraph({
						style: "Quote",
						children: [text("Ship the smallest thing that teaches you something.")],
					}),

					heading(HeadingLevel.HEADING_1, "5. Table"),
					body("A table of three columns and three rows under a header row:"),
					new Table({
						width: { size: 9360, type: WidthType.DXA },
						columnWidths: COLUMN_WIDTHS,
						rows: [
							row(["Milestone", "Owner", "Date"], true),
							row(["Private beta", "Priya", "12 January"]),
							row(["Public launch", "Marco", "2 March"]),
							row(["Retrospective", "Aiko", "16 March"]),
						],
					}),
					body(""),

					heading(HeadingLevel.HEADING_1, "6. Code"),
					body(
						"Run ",
						new TextRun({ text: "bun run dev", style: "HTMLCode" }),
						" to start the app.",
					),
					...CODE_LINES.map(
						(line) =>
							new Paragraph({ style: "HTMLPreformatted", children: [new TextRun({ text: line })] }),
					),

					heading(HeadingLevel.HEADING_1, "7. Images"),
					body("A blue rectangle sits between this paragraph and the next:"),
					new Paragraph({
						children: [picture(image, "A plain blue rectangle", { width: 320, height: 120 })],
					}),
					body("This paragraph comes straight after the image."),
					body("A GIF, then an image that links to a page:"),
					new Paragraph({
						children: [
							picture({ type: "gif", data: ONE_PIXEL_GIF }, "A one-pixel GIF", {
								width: 32,
								height: 32,
							}),
						],
					}),
					new Paragraph({
						children: [
							new ExternalHyperlink({
								link: LINKED_IMAGE_LINK,
								children: [
									picture({ type: "png", data: png(120, 40, [20, 160, 120]) }, "A linked image", {
										width: 120,
										height: 40,
									}),
								],
							}),
						],
					}),

					heading(HeadingLevel.HEADING_1, "8. Layout"),
					body(
						"The next paragraph is centred, the one after is right-aligned, then come a horizontal line as Word draws one, a line typed as three hyphens, and a page break that starts page two.",
					),
					new Paragraph({
						alignment: AlignmentType.CENTER,
						spacing: { after: 160 },
						children: [text("A centred paragraph.")],
					}),
					new Paragraph({
						alignment: AlignmentType.RIGHT,
						spacing: { after: 160 },
						children: [text("A right-aligned paragraph.")],
					}),
					new Paragraph({ children: [text(HORIZONTAL_LINE_HERE)] }),
					// What Word makes of three typed hyphens: an empty paragraph, bordered along its bottom.
					new Paragraph({
						border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "auto", space: 1 } },
						children: [],
					}),
					new Paragraph({ children: [new PageBreak()] }),
					heading(HeadingLevel.HEADING_1, "9. After the page break"),
					body("This is the last paragraph. If you can read it, the whole document came through."),
				],
			},
		],
	});
}
