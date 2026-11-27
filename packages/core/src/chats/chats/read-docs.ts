import type { InputOf, OutputOf } from "@sugabots/contracts/operations";
import { type DocPage, docPages } from "@sugabots/docs";

export const docsPageList = docPages.map(pageEntry).join("\n");

function pageEntry(page: DocPage): string {
	const headings = page.sections.map((section) => section.heading).join(" · ");
	return `- ${page.slug}: ${page.description}${headings ? `\n  Sections: ${headings}` : ""}`;
}

export function readDocsPage({
	page: slug,
	sections: headings,
}: InputOf<"chats.readDocs">): OutputOf<"chats.readDocs"> {
	const page = docPages.find((candidate) => candidate.slug === slug.trim().toLowerCase());
	if (!page) {
		return {
			refused: `There is no page called ${slug}. The pages are: ${docPages.map((candidate) => candidate.slug).join(", ")}.`,
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
