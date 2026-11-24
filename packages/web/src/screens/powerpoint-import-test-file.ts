import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import { png } from "./word-import-test-file.ts";

/*
 * The PowerPoint file `powerpoint-import.test.ts` imports: a deck as people
 * make one, of text boxes, pictures and shapes placed by hand on blank slides
 * rather than in a template's placeholders, a slide for each kind of slide
 * the import lays out, each saying what it holds.
 */

/** The file's picture, a blue PNG. */
export const TEST_PICTURE = new Uint8Array(png(320, 200, [47, 111, 235]));

/** A one-pixel BMP, a kind of image a deck doesn't keep. */
const ONE_PIXEL_BMP =
	"Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAA628vAA==";

/** Where the link on the bulleted slide goes. */
export const TEST_LINK = "https://example.com/plan";

/** The file, as PowerPoint writes one. */
export async function powerPointImportTestFile(): Promise<ArrayBuffer> {
	const presentation = testPresentation();
	return asPowerPointWritesIt(await presentation.write({ outputType: "uint8array" }));
}

const FONT = "Calibri";

/** Where a slide's title box sits, across its top, and the box under it, in inches on a 13.33 by 7.5 inch slide. */
const TITLE_BOX = { x: 0.6, y: 0.4, w: 12.1, h: 0.9 };
const BODY_BOX = { x: 0.6, y: 1.5, w: 12.1, h: 5.2 };
const LEFT_BOX = { x: 0.6, y: 1.5, w: 5.8, h: 5.2 };
const RIGHT_BOX = { x: 6.9, y: 1.5, w: 5.8, h: 5.2 };

type Slide = PptxGenJS.Slide;

const title = (slide: Slide, words: string) =>
	slide.addText(words, { ...TITLE_BOX, fontFace: FONT, fontSize: 32, bold: true });

const run = (text: string, options: PptxGenJS.TextPropsOptions = {}): PptxGenJS.TextProps => ({
	text,
	options,
});

function testPresentation(): PptxGenJS {
	const presentation = new PptxGenJS();
	presentation.layout = "LAYOUT_WIDE";
	presentation.title = "PowerPoint import test";

	// 1. A title slide: a large title, and a subtitle under it.
	const opening = presentation.addSlide();
	opening.addText("Quarterly review", {
		x: 1,
		y: 2.4,
		w: 11.3,
		h: 1.2,
		fontFace: FONT,
		fontSize: 44,
		bold: true,
		align: "center",
	});
	opening.addText("Q3, for the whole team", {
		x: 1,
		y: 3.7,
		w: 11.3,
		h: 0.6,
		fontFace: FONT,
		fontSize: 24,
		align: "center",
	});
	opening.addNotes("Welcome everyone.\nSay the new pod's name.");

	// 2. A title over bullets at two levels, with formatting and a link, then a numbered list.
	const goals = presentation.addSlide();
	title(goals, "Goals");
	goals.addText(
		[
			run("Ship ", { bullet: true }),
			run("live", { italic: true }),
			run(" slides", { breakLine: true }),
			run("with suggestions", { bullet: true, indentLevel: 1, breakLine: true }),
			run("and notes", { bullet: true, indentLevel: 1, breakLine: true }),
			run("Keep ", { bullet: true }),
			run("everything", { bold: true }),
			run(", see ", {}),
			run("the plan", { hyperlink: { url: TEST_LINK }, breakLine: true }),
			run("x", { bullet: true }),
			run("2", { superscript: true }),
			run(" and H"),
			run("2", { subscript: true }),
			run("O, "),
			run("underlined", { underline: { style: "sng" } }),
			run(" and "),
			run("struck", { strike: "sngStrike", breakLine: true }),
			run("Write it", { bullet: { type: "number" }, breakLine: true }),
			run("Ship it", { bullet: { type: "number" } }),
		],
		{ ...BODY_BOX, fontFace: FONT, fontSize: 18, valign: "top" },
	);
	goals.addNotes("Keep this one short.");
	goals.slideNumber = { x: 12.3, y: 6.9, fontSize: 10 };

	// 3. Two text boxes side by side under a title.
	const sides = presentation.addSlide();
	title(sides, "People and bots");
	sides.addText(
		[run("People", { bold: true, breakLine: true }), run("Type in the page at the same time.")],
		{ ...LEFT_BOX, fontFace: FONT, fontSize: 18, valign: "top" },
	);
	sides.addText(
		[run("Bots", { bold: true, breakLine: true }), run("Suggest changes to accept or undo.")],
		{ ...RIGHT_BOX, fontFace: FONT, fontSize: 18, valign: "top" },
	);

	// 4. Words beside a picture.
	const chart = presentation.addSlide();
	title(chart, "Sales went up");
	chart.addText("Every region grew, the north most of all.", {
		...LEFT_BOX,
		fontFace: FONT,
		fontSize: 18,
		valign: "top",
	});
	chart.addImage({ data: pictureData(), ...RIGHT_BOX, altText: "The sales chart" });

	// 5. A table, its second row's first cell merged across the row.
	const owners = presentation.addSlide();
	title(owners, "Owners");
	owners.addTable(
		[
			[
				{ text: "Milestone", options: { bold: true } },
				{ text: "Owner", options: { bold: true } },
			],
			[{ text: "Beta, shared by everyone", options: { colspan: 2 } }],
			[{ text: "Launch" }, { text: "Marco" }],
		],
		{ ...BODY_BOX, h: 1.5, fontFace: FONT, fontSize: 16 },
	);

	// 6. Only a picture.
	presentation.addSlide().addImage({ data: pictureData(), x: 2, y: 1, w: 9.3, h: 5.5 });

	// 7. A chart and shapes under a title: one drawn shape without words, one with, and a picture of a kind a deck can't show.
	const revenue = presentation.addSlide();
	title(revenue, "Revenue");
	revenue.addChart(
		presentation.ChartType.bar,
		[{ name: "Revenue", labels: ["Q1", "Q2", "Q3"], values: [3, 5, 8] }],
		{ x: 0.6, y: 1.5, w: 7, h: 5 },
	);
	revenue.addShape(presentation.ShapeType.rect, {
		x: 8,
		y: 1.5,
		w: 1,
		h: 1,
		fill: { color: "2563EB" },
	});
	revenue.addText("Up 60% on last year", {
		shape: presentation.ShapeType.ellipse,
		x: 8,
		y: 3,
		w: 4,
		h: 1.5,
		fill: { color: "FDE68A" },
		fontFace: FONT,
		fontSize: 16,
	});
	revenue.addImage({ data: `image/bmp;base64,${ONE_PIXEL_BMP}`, x: 8, y: 5, w: 1, h: 1 });
	revenue.addNotes("The chart is in the appendix too.");

	// 8. A quote, in quotation marks, with whose words they are under it.
	const quote = presentation.addSlide();
	quote.addText("“Nothing a person writes is lost.”", {
		x: 1.5,
		y: 2,
		w: 10.3,
		h: 2,
		fontFace: FONT,
		fontSize: 36,
	});
	quote.addText("Priya, at the launch", { x: 1.5, y: 4.2, w: 10.3, h: 0.6, fontSize: 18 });

	// 9. Only a title, later in the deck.
	const questions = presentation.addSlide();
	questions.addText("Questions?", {
		x: 1,
		y: 3,
		w: 11.3,
		h: 1.2,
		fontFace: FONT,
		fontSize: 40,
		bold: true,
	});

	// 10. An empty slide.
	presentation.addSlide();
	return presentation;
}

const pictureData = () => `image/png;base64,${Buffer.from(TEST_PICTURE).toString("base64")}`;

/** A paragraph's properties, which PptxGenJS writes before each of its runs, and PowerPoint once, first. */
const PARAGRAPH_PROPERTIES = /<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/g;

/** The words PptxGenJS gives a picture that has none, the name it files the picture's bytes under. */
const MADE_UP_PICTURE_WORDS = ' descr="preencoded.png"';

/**
 * `file` as PowerPoint writes one: each paragraph's properties once, first,
 * where PptxGenJS writes them before each run, a bullet only in the first,
 * which a reader may take the paragraph to have none from; and a picture
 * without words given none.
 */
async function asPowerPointWritesIt(
	file: Awaited<ReturnType<PptxGenJS["write"]>>,
): Promise<ArrayBuffer> {
	const zip = await JSZip.loadAsync(file);
	for (const path of Object.keys(zip.files).filter((name) =>
		/^ppt\/slides\/slide\d+\.xml$/.test(name),
	)) {
		const xml = (await zip.file(path)?.async("string")) ?? "";
		zip.file(
			path,
			xml.replaceAll(MADE_UP_PICTURE_WORDS, "").replace(/<a:p>[\s\S]*?<\/a:p>/g, (paragraph) => {
				let first = true;
				return paragraph.replace(PARAGRAPH_PROPERTIES, (properties) => {
					const kept = first ? properties : "";
					first = false;
					return kept;
				});
			}),
		);
	}
	return zip.generateAsync({ type: "arraybuffer" });
}
