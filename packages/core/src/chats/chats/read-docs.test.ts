import type { OutputOf } from "@sugabots/contracts/operations";
import { type DocPage, type DocSection, docPages } from "@sugabots/docs";
import { roleAbilities } from "@sugabots/docs/roles";
import { describe, expect, it } from "vitest";
import { docsPageList, readDocsPage as read } from "./read-docs.ts";

function markdownOf(result: OutputOf<"chats.readDocs">): string {
	if ("refused" in result) throw new Error(`Refused: ${result.refused}`);
	return result.markdown;
}

/** A section's `##` line, which its page's Markdown has whatever else changes. */
function headingLine(section: DocSection | undefined): string {
	return section?.markdown.split("\n")[0] ?? "";
}

const pageWithSections = docPages.find((page) => page.sections.length >= 2) as DocPage;

describe("read_docs", () => {
	it("lists every page and its sections in its description", () => {
		expect(docPages.length).toBeGreaterThan(0);
		for (const page of docPages) {
			expect(docsPageList).toContain(`- ${page.slug}: ${page.description}`);
			for (const section of page.sections) expect(docsPageList).toContain(section.heading);
		}
	});

	it.each(docPages.map((page) => [page.slug, page] as const))(
		"reads the whole %s page",
		(slug, page) => {
			const markdown = markdownOf(read({ page: slug }));
			expect(markdown.startsWith(`# ${page.title}\n\n${page.description}`)).toBe(true);
			for (const section of page.sections) expect(markdown).toContain(headingLine(section));
		},
	);

	it("reads only the sections asked for, whatever their case", () => {
		const [first, second] = pageWithSections.sections;
		const markdown = markdownOf(
			read({ page: pageWithSections.slug, sections: [first?.heading.toUpperCase() ?? ""] }),
		);
		expect(markdown).toContain(`# ${pageWithSections.title}`);
		expect(markdown).toContain(headingLine(first));
		expect(markdown).not.toContain(headingLine(second));
	});

	it("names the pages there are when the page doesn't exist", () => {
		expect(read({ page: "billing" })).toEqual({
			refused: expect.stringContaining(docPages.map((page) => page.slug).join(", ")),
		});
	});

	it("names the page's sections when a section doesn't exist", () => {
		const result = read({ page: pageWithSections.slug, sections: ["Pricing"] });
		expect(result).toEqual({
			refused: expect.stringContaining(
				pageWithSections.sections.map((section) => section.heading).join(", "),
			),
		});
		expect(result).toEqual({ refused: expect.stringContaining("Pricing") });
	});

	it("writes out what each role may do, where the website shows an interactive table", () => {
		const markdown = markdownOf(read({ page: "members-and-roles", sections: ["Roles"] }));
		expect(markdown).not.toContain("<RoleMatrix");
		for (const ability of roleAbilities) expect(markdown).toContain(ability.label);
	});

	it("leaves out the padding that lines up tables' columns", () => {
		const tableLines = docPages
			.map((page) => read({ page: page.slug }))
			.flatMap((result) =>
				markdownOf(result)
					.split("\n")
					.filter((line) => line.startsWith("|")),
			);
		expect(tableLines.length).toBeGreaterThan(0);
		expect(tableLines.filter((line) => / {2}|-{4}/.test(line))).toEqual([]);
	});
});
