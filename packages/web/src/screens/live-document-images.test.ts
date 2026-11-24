import {
	type ArtifactImageIds,
	artifactImageAddress,
	artifactImageIds,
} from "@sugabots/contracts/http";
import { liveDocumentExtensions } from "@sugabots/contracts/live-document";
import { Editor, getSchema } from "@tiptap/core";
import { DOMParser, DOMSerializer, type Node } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";

/*
 * An image in the editor, drawn and copied as the editor draws and copies it:
 * by the schema's own rules for the page and the clipboard.
 */

const artifact = {
	podId: "0199a3a0-0000-7000-8000-000000000001",
	artifactId: "0199a3a0-0000-7000-8000-000000000002",
};

function keptFor(artifactId: string): ArtifactImageIds {
	const ids = artifactImageIds({ podId: artifact.podId, artifactId, imageId: "a".repeat(64) });
	if (!ids) throw new Error("fixture");
	return ids;
}

const own = artifactImageAddress(keptFor(artifact.artifactId));
const anotherDocuments = artifactImageAddress(keptFor("0199a3a0-0000-7000-8000-000000000009"));
const outside = "https://tracker.example/pixel.png";

/** Where this API serves an image from, on an origin of its own. */
const source = (ids: ArtifactImageIds) => `https://api.example.com/api/images/${ids.imageId}`;

const schema = getSchema(liveDocumentExtensions({ undo: false, ownImages: { artifact, source } }));

const imageAt = (src: string) =>
	schema.node("image", { src, alt: `Chart at ${src}`, title: "Launch chart" });

const LINK_TITLE = "Where the chart is explained";

const linkedImageAt = (src: string, link: string) =>
	schema.node("image", { ...imageAt(src).attrs, link, linkTitle: LINK_TITLE });

/** Words linked to `href`, as a text link is. */
function wordsLinkedTo(href: string): Node {
	const link = schema.marks.link;
	if (!link) throw new Error("fixture");
	return schema.text("The chart", [link.create({ href, title: LINK_TITLE })]);
}

/** The images, or words, as the page draws them. */
function drawn<Drawn extends Element = HTMLImageElement>(nodes: Node[]): Drawn[] {
	const line = schema.node("paragraph", null, nodes);
	const page = DOMSerializer.fromSchema(schema).serializeFragment(line.content, { document });
	return [...page.childNodes] as Drawn[];
}

const attributesOf = (element: Element | undefined) =>
	Object.fromEntries([...(element?.attributes ?? [])].map(({ name, value }) => [name, value]));

describe("an image in the editor", () => {
	it("loads only when it is the document's own, from where the API is", () => {
		const [ownImage, theirs, outsideImage] = drawn([
			imageAt(own),
			imageAt(anotherDocuments),
			imageAt(outside),
		]);

		expect(ownImage?.getAttribute("src")).toBe(source(keptFor(artifact.artifactId)));
		expect(theirs?.hasAttribute("src")).toBe(false);
		expect(outsideImage?.hasAttribute("src")).toBe(false);
		expect(outsideImage?.getAttribute("alt")).toBe(`Chart at ${outside}`);
	});

	it("sits in its link, drawn as a text link to the same place is, loading only when the document's own", () => {
		const [ownLinked, outsideLinked, scriptLinked] = drawn<HTMLAnchorElement>([
			linkedImageAt(own, "https://example.com/chart"),
			linkedImageAt(outside, "https://example.com/chart"),
			linkedImageAt(own, "javascript:alert(1)"),
		]);
		const [textLink] = drawn<HTMLAnchorElement>([wordsLinkedTo("https://example.com/chart")]);
		const [textScriptLink] = drawn<HTMLAnchorElement>([wordsLinkedTo("javascript:alert(1)")]);

		expect(attributesOf(ownLinked)).toEqual(attributesOf(textLink));
		expect(attributesOf(scriptLinked)).toEqual(attributesOf(textScriptLink));
		expect(ownLinked?.querySelector("img")?.getAttribute("src")).toBe(
			source(keptFor(artifact.artifactId)),
		);
		expect(outsideLinked?.querySelector("img")?.hasAttribute("src")).toBe(false);
	});

	it("keeps its address, words, title and link when copied and pasted, loaded or not", () => {
		const images = [
			imageAt(own),
			imageAt(anotherDocuments),
			imageAt(outside),
			linkedImageAt(own, "https://example.com/chart"),
			linkedImageAt(outside, "https://example.com/chart"),
		];
		const clipboard = document.createElement("div");
		clipboard.append(...drawn(images));

		const pasted = DOMParser.fromSchema(schema).parseSlice(clipboard).content;

		const attrs: unknown[] = [];
		pasted.descendants((node) => {
			if (node.type.name === "image") attrs.push(node.attrs);
		});
		expect(attrs).toEqual(images.map((image) => image.attrs));
	});
});

describe("a link on an image in the editor", () => {
	const editors: Editor[] = [];
	afterEach(() => {
		for (const editor of editors.splice(0)) editor.destroy();
	});

	function editorHolding(html: string): Editor {
		const editor = new Editor({
			element: document.createElement("div"),
			extensions: liveDocumentExtensions({ undo: true, ownImages: { artifact, source } }),
		});
		editors.push(editor);
		editor.commands.setContent(html);
		return editor;
	}

	/** What each piece of the line links to, words by their text and the image as `image`. */
	function linksIn(editor: Editor): string[] {
		const links: string[] = [];
		editor.state.doc.descendants((node) => {
			if (!node.isInline) return;
			const mark = node.marks.find((candidate) => candidate.type.name === "link");
			const linkedTo = node.isText ? mark?.attrs.href : node.attrs.link;
			links.push(`${node.isText ? node.text : `image${mark ? " marked" : ""}`} to ${linkedTo}`);
		});
		return links;
	}

	it("is the image's own, and not a mark on it, when the image comes inside a link holding words", () => {
		const editor = editorHolding(
			`<p><a href="https://example.com/chart">Read <img data-address="${own}" alt="Chart"> here</a></p>`,
		);

		expect(linksIn(editor)).toEqual([
			"Read  to https://example.com/chart",
			"image to https://example.com/chart",
			" here to https://example.com/chart",
		]);
	});

	it("goes on and comes off the image with the text around it", () => {
		const editor = editorHolding(`<p>Read <img data-address="${own}" alt="Chart"> here</p>`);

		editor.chain().selectAll().setLink({ href: "https://example.com/chart" }).run();
		expect(linksIn(editor)).toEqual([
			"Read  to https://example.com/chart",
			"image to https://example.com/chart",
			" here to https://example.com/chart",
		]);

		editor.chain().selectAll().unsetLink().run();
		expect(linksIn(editor)).toEqual(["Read  to undefined", "image to null", " here to undefined"]);
	});
});
