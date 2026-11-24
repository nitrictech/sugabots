import type { ArtifactImageType } from "@sugabots/contracts";
import {
	type ArtifactImageIds,
	artifactImageAddress,
	artifactImageIds,
} from "@sugabots/contracts/http";
import { Effect } from "effect";
import JSZip from "jszip";
import mammoth from "mammoth";
import { describe, expect, it } from "vitest";
import { type WordImage, wordFileOf } from "./word.ts";

/*
 * A document's Word file, read back as the web app reads a Word file it
 * imports, with the same reading of underline, highlight, quotes, code and
 * page breaks, and its own XML where a reading leaves something out. (The
 * web import also reads a horizontal line as a divider, which mammoth alone
 * can't; `live-document.test.tsx` covers that.)
 */

const ARTIFACT = {
	podId: "0199a3a0-0000-7000-8000-000000000001",
	id: "0199a3a0-0000-7000-8000-000000000002",
	title: "Launch plan",
};

/** One-pixel images of each kind a document keeps. */
const IMAGES: Record<ArtifactImageType, Buffer> = {
	"image/png": Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"base64",
	),
	"image/jpeg": Buffer.from(
		"/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
		"base64",
	),
	"image/gif": Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
	"image/webp": Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64"),
};

/** The address of an image kept for `artifactId`, by the id of the kind it is. */
function keptImage(type: ArtifactImageType, artifactId = ARTIFACT.id): string {
	const imageId = Buffer.from(type).toString("hex").padEnd(64, "0").slice(0, 64);
	const ids = artifactImageIds({ podId: ARTIFACT.podId, artifactId, imageId });
	if (!ids) throw new Error("fixture");
	return artifactImageAddress(ids);
}

/** The images the artifact keeps, by id: one of each kind. */
const keptImages = new Map(
	(Object.keys(IMAGES) as ArtifactImageType[]).map((type) => [
		keptImage(type).split("/").at(-1),
		{ contentType: type, bytes: IMAGES[type] } satisfies WordImage,
	]),
);

/** The Word file of `markdown`, and the images it asked for. */
async function wordFile(markdown: string) {
	const asked: ArtifactImageIds[] = [];
	const file = await Effect.runPromise(
		wordFileOf(ARTIFACT, markdown, (image) => {
			asked.push(image);
			return Effect.succeed(keptImages.get(image.imageId));
		}),
	);
	return { file, asked };
}

const readBack = async (file: Uint8Array) =>
	(
		await mammoth.convertToHtml(
			{ buffer: Buffer.from(file) },
			{
				styleMap: [
					"u => u",
					"highlight => mark",
					"br[type='page'] => hr",
					"p[style-name='Quote'] => blockquote > p:fresh",
					"r[style-name='HTML Code'] => code",
					"p[style-name='HTML Preformatted'] => pre:separator('\\n')",
				],
			},
		)
	).value;

/** `html`, text or an attribute's value as mammoth writes it, with its escapes undone. */
const unescapedHtml = (html: string) =>
	html.replace(
		/&(quot|amp|lt|gt);/g,
		(_escape, name: string) => ({ quot: '"', amp: "&", lt: "<", gt: ">" })[name] ?? "",
	);

const partOf = async (file: Uint8Array, part: string) =>
	(await JSZip.loadAsync(file)).file(part)?.async("string") ?? "";

const documentXml = (file: Uint8Array) => partOf(file, "word/document.xml");

/** The text of each paragraph of `xml` in the paragraph style `styleId`, with a tab as `\t`. */
const textsInStyle = (xml: string, styleId: string) =>
	(
		xml.match(new RegExp(`<w:p>\\s*<w:pPr><w:pStyle w:val="${styleId}"/>[\\s\\S]*?</w:p>`, "g")) ??
		[]
	).map((paragraph) =>
		[...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)]
			.map(([, text]) => text ?? "\t")
			.join(""),
	);

/** What each run of `xml` in Word's HTML Code style holds. */
const runsInCodeStyle = (xml: string) =>
	[...xml.matchAll(/<w:r>\s*<w:rPr><w:rStyle w:val="HTMLCode"\/>([\s\S]*?)<\/w:r>/g)].map(
		([, run]) => run ?? "",
	);

describe("a document's Word file", () => {
	it("holds its table, its header row marked as Word's and in bold", async () => {
		const { file } = await wordFile("| Milestone | Owner |\n| --- | --- |\n| Beta | Priya |");

		const rows = (await documentXml(file)).match(/<w:tr>[\s\S]*?<\/w:tr>/g) ?? [];
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatch(/^<w:tr>\s*<w:trPr><w:tblHeader\/><\/w:trPr>/);
		expect(rows[1]).not.toContain("tblHeader");
		expect(await readBack(file)).toContain(
			"<table><thead><tr><th><p><strong>Milestone</strong></p></th><th><p><strong>Owner</strong></p></th></tr></thead><tbody><tr><td><p>Beta</p></td><td><p>Priya</p></td></tr></tbody></table>",
		);
	});

	it("puts a quote's paragraphs in Word's own Quote style, which reads back as one quote", async () => {
		const { file } = await wordFile("Before.\n\n> First thought.\n>\n> Second thought.\n\nAfter.");

		const xml = await documentXml(file);
		const quoted = xml.match(/<w:p>\s*<w:pPr><w:pStyle w:val="Quote"\/>[\s\S]*?<\/w:p>/g) ?? [];
		expect(quoted.map((paragraph) => paragraph.match(/<w:t[^>]*>([^<]*)</)?.[1])).toEqual([
			"First thought.",
			"Second thought.",
		]);
		expect(await partOf(file, "word/styles.xml")).toMatch(
			/<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"\/>/,
		);
		expect(await readBack(file)).toBe(
			"<p>Before.</p><blockquote><p>First thought.</p><p>Second thought.</p></blockquote><p>After.</p>",
		);
	});

	it("keeps a list in a quote as a list between the quote's paragraphs, and a quote within a quote in it", async () => {
		const { file } = await wordFile("> Intro.\n>\n> - one\n> - two\n>\n> Outro.\n>\n> > Inner.");

		expect(await readBack(file)).toBe(
			"<blockquote><p>Intro.</p></blockquote><ul><li>one</li><li>two</li></ul><blockquote><p>Outro.</p><p>Inner.</p></blockquote>",
		);
	});

	it("holds every kind of image the document keeps, each declared as the kind it is", async () => {
		const types = Object.keys(IMAGES) as ArtifactImageType[];
		const { file } = await wordFile(
			types.map((type) => `![A chart](${keptImage(type)})`).join("\n\n"),
		);

		const html = await readBack(file);
		for (const type of types) {
			expect(html).toContain(
				`<img alt="A chart" src="data:${type};base64,${IMAGES[type].toString("base64")}" />`,
			);
		}
		const declared = await partOf(file, "[Content_Types].xml");
		expect(declared).toContain('<Default Extension="gif" ContentType="image/gif"/>');
		expect(declared).toContain('<Default Extension="webp" ContentType="image/webp"/>');
	});

	it("holds a linked image inside its link, which reads back as a linked image", async () => {
		const { file } = await wordFile(
			`[![A PNG chart](${keptImage("image/png")})](https://example.com/chart) and [![A tracker](https://tracker.example/pixel.png)](https://example.com/away)`,
		);

		expect(await documentXml(file)).toMatch(
			/<w:hyperlink r:id="[^"]+">\s*<w:r>(?:(?!<\/w:r>)[\s\S])*<w:drawing>/,
		);
		const html = await readBack(file);
		expect(html).toContain(
			`<a href="https://example.com/chart"><img alt="A PNG chart" src="data:image/png;base64,${IMAGES["image/png"].toString("base64")}" /></a>`,
		);
		expect(html).toContain('<a href="https://example.com/away">A tracker</a>');
	});

	it("gives each image its own words where Word reads them, which read back exactly", async () => {
		const words = 'Say "hi" & café <b>\nline two';
		const { file } = await wordFile(
			[
				`![${words}](${keptImage("image/png")})`,
				`![Second](${keptImage("image/jpeg")}) ![Same image, other words](${keptImage("image/jpeg")})`,
				`![](${keptImage("image/gif")})`,
				`[![In a link](${keptImage("image/png")})](https://example.com/chart)`,
				`| Chart |\n| --- |\n| ![In a cell](${keptImage("image/webp")}) |`,
			].join("\n\n"),
		);

		const drawings = (await documentXml(file)).match(/<wp:docPr\s[^>]*>/g) ?? [];
		expect(drawings.map((drawing) => /\bdescr="([^"]*)"/.exec(drawing)?.[1])).toEqual([
			"Say &quot;hi&quot; &amp; café &lt;b&gt;&#10;line two",
			"Second",
			"Same image, other words",
			undefined,
			"In a link",
			"In a cell",
		]);
		const ids = drawings.map((drawing) => /\bid="([^"]*)"/.exec(drawing)?.[1]);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).not.toContain("0");
		const readWords = [...(await readBack(file)).matchAll(/<img (?:alt="([^"]*)" )?src=/g)].map(
			([, alt]) => alt && unescapedHtml(alt),
		);
		expect(readWords).toEqual([
			words,
			"Second",
			"Same image, other words",
			undefined,
			"In a link",
			"In a cell",
		]);
	});

	it("asks only for the images the document keeps, and leaves any other as its words", async () => {
		const { file, asked } = await wordFile(
			[
				`![Ours](${keptImage("image/png")}) ![Theirs](${keptImage("image/png", "0199a3a0-0000-7000-8000-000000000009")})`,
				"![A tracker](https://tracker.example/pixel.png) <script>alert(1)</script>",
			].join("\n\n"),
		);

		expect(asked.map(({ artifactId }) => artifactId)).toEqual([ARTIFACT.id]);
		const html = await readBack(file);
		expect(html).toContain("Theirs</p>");
		expect(html).toContain("<p>A tracker &lt;script&gt;alert(1)&lt;/script&gt;</p>");
		expect(html.match(/<img/g)).toHaveLength(1);
	});

	it("keeps its marks, with a highlight as Word's own, which reads back as one", async () => {
		const { file } = await wordFile(
			"x<sup>2</sup>, H<sub>2</sub>O, <u>firm</u>, ~~gone~~ and <mark>launch day</mark>.",
		);

		expect(await readBack(file)).toContain(
			"<p>x<sup>2</sup>, H<sub>2</sub>O, <u>firm</u>, <s>gone</s> and <mark>launch day</mark>.</p>",
		);
		expect(await documentXml(file)).toMatch(
			/<w:rPr>\s*<w:highlight w:val="yellow"\/>\s*<\/w:rPr>\s*<w:t xml:space="preserve">launch day<\/w:t>/,
		);
	});

	it("puts a highlight before the underline it shares a run with, where Word reads it", async () => {
		// As the editor writes text that is both.
		const { file } = await wordFile("Ship <u><mark>on time</mark></u>.");

		const xml = await documentXml(file);
		expect(xml).toMatch(
			/<w:rPr>\s*<w:highlight w:val="yellow"\/>\s*<w:u w:val="single"\/>\s*<\/w:rPr>\s*<w:t xml:space="preserve">on time<\/w:t>/,
		);
		expect(xml).not.toContain("<w:shd");
		expect(await readBack(file)).toMatch(/<(u|mark)><(u|mark)>on time<\/\2><\/\1>/);
	});

	it("puts inline code in Word's own HTML Code style, in bold, a link and a table cell too", async () => {
		const { file } = await wordFile(
			"Run `a < b && c`, **bold `x`** and [see `docs`](https://example.com/docs).\n\n| Key | Value |\n| --- | --- |\n| `id` | 1 |",
		);

		const xml = await documentXml(file);
		const runs = runsInCodeStyle(xml);
		expect(runs.map((run) => run.match(/<w:t[^>]*>([^<]*)</)?.[1])).toEqual([
			"a &lt; b &amp;&amp; c",
			"x",
			"docs",
			"id",
		]);
		expect(runs[1]).toContain("<w:b/>");
		expect(runs[2]).not.toContain("Hyperlink");
		expect(await partOf(file, "word/styles.xml")).toMatch(
			/<w:style w:type="character" w:styleId="HTMLCode"><w:name w:val="HTML Code"\/>.*Courier New/,
		);
		const html = await readBack(file);
		expect(html).toContain("<p>Run <code>a &lt; b &amp;&amp; c</code>, <strong>bold </strong>");
		expect(html).toContain('<a href="https://example.com/docs">see <code>docs</code></a>');
		expect(html).toContain("<td><p><code>id</code></p></td>");
	});

	it("writes each line of a code block as a paragraph in Word's own HTML Preformatted style, which reads back as one block", async () => {
		const { file } = await wordFile(
			'Before.\n\n```js\nif (a < b && c) {\n\treturn "<b>";\n    // indented\n}\n```\n\nAfter.',
		);

		const xml = await documentXml(file);
		expect(textsInStyle(xml, "HTMLPreformatted")).toEqual([
			"if (a &lt; b &amp;&amp; c) {",
			'\treturn "&lt;b&gt;";',
			"    // indented",
			"}",
		]);
		expect(xml).toContain('<w:t xml:space="preserve">    // indented</w:t>');
		expect(xml).not.toContain('w:ascii="Courier"');
		expect(await partOf(file, "word/styles.xml")).toMatch(
			/<w:style w:type="paragraph" w:styleId="HTMLPreformatted"><w:name w:val="HTML Preformatted"\/>.*Courier New/,
		);
		expect(await readBack(file)).toBe(
			'<p>Before.</p><pre>if (a &lt; b &amp;&amp; c) {\n\treturn "&lt;b&gt;";\n    // indented\n}</pre><p>After.</p>',
		);
	});

	it("keeps an empty line of a code block as a line of it, so the block stays one in Word", async () => {
		const { file } = await wordFile("```\nfirst\n\nthird\n```");

		expect(textsInStyle(await documentXml(file), "HTMLPreformatted")).toEqual([
			"first",
			"",
			"third",
		]);
	});

	it("keeps a code block in a list item or a quote as code", async () => {
		const { file } = await wordFile(
			"- Install:\n\n  ```\n  bun install\n  ```\n\n> Then:\n>\n> ```\n> bun run dev\n> ```",
		);

		expect(textsInStyle(await documentXml(file), "HTMLPreformatted")).toEqual([
			"bun install",
			"bun run dev",
		]);
		expect(await readBack(file)).toBe(
			"<ul><li>Install:</li></ul><pre>bun install</pre><blockquote><p>Then:</p></blockquote><pre>bun run dev</pre>",
		);
	});

	it("draws a divider as Word's horizontal line", async () => {
		const { file } = await wordFile("Before.\n\n---\n\nAfter.");

		const xml = await documentXml(file);
		expect(xml).toMatch(
			/>Before\.<\/w:t>[\s\S]*<w:p><w:r><w:pict><v:rect [^>]*o:hr="t"[^>]*\/><\/w:pict><\/w:r><\/w:p>[\s\S]*>After\.<\/w:t>/,
		);
		expect(await readBack(file)).toBe("<p>Before.</p><p>After.</p>");
	});
});
