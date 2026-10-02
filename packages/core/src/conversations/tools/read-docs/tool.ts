import type { DocPage } from "@sugabots/docs";
import { tool } from "ai";
import { Schema } from "effect";

export const READ_DOCS_TOOL = "read_docs";

export type ReadDocsResult = { markdown: string } | { refused: string };

/**
 * The `read_docs` tool: a page of Sugabots' own docs, or some of its
 * sections, so a bot answers questions about the app from the docs of the
 * version it runs in. The description lists every page and section, so the
 * bot can ask for the right one in its first call.
 */
export function readDocsTool(pages: readonly DocPage[]) {
	return tool({
		description: [
			"Read the documentation for Sugabots, the app this conversation is in. Use it when someone asks how to do something in Sugabots or how part of it works, and answer from what it says rather than from memory.",
			"Give a page, and the headings of the sections you need to read only those. The pages, each with its sections:",
			pages.map(pageEntry).join("\n"),
		].join("\n\n"),
		inputSchema: Schema.Struct({
			page: Schema.String.annotate({ description: "The page's name, as listed, like routines" }),
			sections: Schema.optional(
				Schema.Array(Schema.String).annotate({
					description: "Headings of the sections to read, as listed. Leave out for the whole page.",
				}),
			),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async ({ page, sections }): Promise<ReadDocsResult> => readDocs(pages, page, sections),
	});
}

function pageEntry(page: DocPage): string {
	const headings = page.sections.map((section) => section.heading).join(" · ");
	return `- ${page.slug}: ${page.description}${headings ? `\n  Sections: ${headings}` : ""}`;
}

function readDocs(
	pages: readonly DocPage[],
	slug: string,
	headings: readonly string[] | undefined,
): ReadDocsResult {
	const page = pages.find((candidate) => candidate.slug === slug.trim().toLowerCase());
	if (!page) {
		return {
			refused: `There is no page called ${slug}. The pages are: ${pages.map((candidate) => candidate.slug).join(", ")}.`,
		};
	}
	const wanted = headings?.length ? headings : undefined;
	const sections = wanted
		? wanted.map((heading) =>
				page.sections.find((section) => sameHeading(section.heading, heading)),
			)
		: page.sections;
	const missing = wanted?.filter((_, index) => !sections[index]);
	if (missing?.length) {
		return {
			refused: `The ${page.slug} page has no section called ${missing.join(" or ")}. Its sections are: ${page.sections.map((section) => section.heading).join(", ")}.`,
		};
	}
	const markdown = [
		`# ${page.title}`,
		page.description,
		page.intro,
		...sections.map((section) => section?.markdown),
	]
		.filter(Boolean)
		.join("\n\n");
	return { markdown: withoutTablePadding(markdown) };
}

function sameHeading(heading: string, asked: string): boolean {
	return (
		heading.toLowerCase() ===
		asked
			.replace(/^#+\s*/, "")
			.trim()
			.toLowerCase()
	);
}

/**
 * The docs' tables are padded so their columns line up in an editor. A model
 * reads them as well without, and the padding is most of a wide table's size.
 */
function withoutTablePadding(markdown: string): string {
	return markdown
		.split("\n")
		.map((line) =>
			line.startsWith("|") ? line.replace(/ {2,}/g, " ").replace(/-{3,}/g, "---") : line,
		)
		.join("\n");
}
