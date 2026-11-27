import type { AttributeSpec, Schema } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { cssColorIn, fontFamilyIn } from "./css-values.ts";
import { LIVE_DOCUMENT_SCHEMA } from "./live-document.ts";
import { liveDocumentSchema } from "./live-document-text.ts";
import { boxAttributesIn } from "./slide-box.ts";
import { slideLayoutIn } from "./slide-layouts.ts";
import { lineHeightIn, textSizeIn } from "./slide-text-style.ts";

/**
 * What the sync layer depends on in a schema: each node's and mark's name,
 * attributes with their defaults, and the rules for what it holds, in an
 * order that doesn't depend on how the extensions are listed.
 */
function syncedSpecOf(schema: Schema) {
	const attributesOf = (attributes: Record<string, AttributeSpec> = {}) =>
		Object.keys(attributes)
			.sort()
			.map((name) => {
				const attribute = attributes[name] ?? {};
				return [name, "default" in attribute ? attribute.default : "required"];
			});
	const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
	return {
		nodes: Object.values(schema.nodes)
			.map(({ name, spec }) => ({
				name,
				content: spec.content ?? "",
				group: spec.group ?? "",
				marks: spec.marks ?? null,
				inline: spec.inline ?? false,
				attributes: attributesOf(spec.attrs),
			}))
			.sort(byName),
		marks: Object.values(schema.marks)
			.map(({ name, spec }) => ({
				name,
				group: spec.group ?? "",
				excludes: spec.excludes ?? null,
				attributes: attributesOf(spec.attrs),
			}))
			.sort(byName),
	};
}

/**
 * A stored value of each attribute whose value has a shape of its own, as an
 * editor stores one, read through the reader that reads it. A change to the
 * shape of a value, as to a stroke's fields, reads its sample differently, so
 * it changes the fingerprint too, though the attribute's name and default
 * stay as they were.
 */
const STORED_SAMPLES = {
	box: boxAttributesIn({
		role: "title",
		verticalAlign: "middle",
		frame: { x: 80, y: 64, width: 800, height: 48 },
		fill: "#1e3a8a",
		stroke: { color: "#93c5fd", width: 2 },
		padding: { top: 1, right: 2, bottom: 3, left: 4 },
		rotation: 15,
		path: "M 0 0 L 10 0 L 10 5 Z",
	}),
	slide: { layout: slideLayoutIn("title"), background: cssColorIn("#0f172a") },
	text: {
		color: cssColorIn("#ffffff"),
		fontFamily: fontFamilyIn('"Source Serif", Georgia, serif'),
		fontSize: textSizeIn(24),
		lineHeight: lineHeightIn(1.2),
	},
};

async function fingerprint(): Promise<string> {
	const spec = JSON.stringify({
		document: syncedSpecOf(liveDocumentSchema("document")),
		slides: syncedSpecOf(liveDocumentSchema("slides")),
		samples: STORED_SAMPLES,
	});
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(spec));
	return [...new Uint8Array(digest)]
		.slice(0, 8)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

describe("LIVE_DOCUMENT_SCHEMA", () => {
	it("changes whenever the nodes, marks or stored values of either kind of live document do", async () => {
		expect(
			{ [LIVE_DOCUMENT_SCHEMA]: await fingerprint() },
			"A live document's nodes or marks, or the shape of a value it stores, changed. Raise LIVE_DOCUMENT_SCHEMA in live-document.ts, so tabs built for the old schema can't join and delete or misread what they can't hold, then record the new number with this fingerprint here.",
		).toEqual({ 9: "8582130ca00b3a1a" });
	});
});
