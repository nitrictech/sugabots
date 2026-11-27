import type { AttributeSpec, Schema } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { LIVE_DOCUMENT_SCHEMA } from "./live-document.ts";
import { liveDocumentSchema } from "./live-document-text.ts";

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

async function fingerprint(): Promise<string> {
	const spec = JSON.stringify({
		document: syncedSpecOf(liveDocumentSchema("document")),
		slides: syncedSpecOf(liveDocumentSchema("slides")),
	});
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(spec));
	return [...new Uint8Array(digest)]
		.slice(0, 8)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

describe("LIVE_DOCUMENT_SCHEMA", () => {
	it("changes whenever the nodes or marks of either kind of live document do", async () => {
		expect(
			{ [LIVE_DOCUMENT_SCHEMA]: await fingerprint() },
			"A live document's nodes or marks changed. Raise LIVE_DOCUMENT_SCHEMA in live-document.ts, so tabs built for the old schema can't join and delete what they can't hold, then record the new number with this fingerprint here.",
		).toEqual({ 9: "c873bc8fa8b1131b" });
	});
});
