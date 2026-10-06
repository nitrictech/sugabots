import { describe, expect, it } from "vitest";
import { type CatalogEntry, catalogListing, LISTING_CHARACTERS, searchCatalog } from "./catalog.ts";

const entry = (
	handle: string,
	name: string,
	{ description = "", callable = true, properties = {} as Record<string, object> } = {},
): CatalogEntry => ({
	key: `${handle}__${name}`,
	handle,
	name,
	description,
	inputSchema: { type: "object", properties },
	callable,
});

describe("the listing of bridged connection tools", () => {
	it("stays within its budget however many tools a connection has, and says how many it left out", () => {
		const entries = [
			entry("notes", "list_notes"),
			...Array.from({ length: 371 }, (_, index) =>
				entry("reports", `run_report_${String(index).padStart(3, "0")}`),
			),
		];

		const listing = catalogListing(entries);

		expect(listing.length).toBeLessThanOrEqual(LISTING_CHARACTERS);
		expect(listing).toContain("- notes (1 tool): list_notes");
		expect(listing).toMatch(/^- reports \(371 tools\): run_report_000, .*, and \d+ more$/m);
	});

	it("leaves out tools that are turned off", () => {
		const listing = catalogListing([
			entry("notes", "list_notes"),
			entry("notes", "delete_note", { callable: false }),
		]);

		expect(listing).toBe("- notes (1 tool): list_notes");
	});
});

describe("searching bridged connection tools", () => {
	it("finds a tool by a plural of a word in its name, ignoring words every description has", () => {
		const entries = [
			entry("tracker", "list_issue", { description: "Lists the issues in a project." }),
			entry("tracker", "create_project", { description: "Creates a project for the team." }),
		];

		expect(searchCatalog(entries, "the open issues").map((found) => found.tool)).toEqual([
			"tracker__list_issue",
		]);
	});

	it("does not find a tool that is turned off", () => {
		const entries = [entry("tracker", "delete_issue", { callable: false })];

		expect(searchCatalog(entries, "delete issue")).toEqual([]);
	});

	it("leaves out the schemas of later matches once a result holds enough of them", () => {
		const huge = { query: { type: "string", description: "x".repeat(15_000) } };
		const entries = [
			entry("reports", "run_report", { properties: huge }),
			entry("reports", "run_report_export", { properties: huge }),
		];

		const found = searchCatalog(entries, "run report");

		expect(found.map((match) => match.tool)).toEqual([
			"reports__run_report",
			"reports__run_report_export",
		]);
		expect(found[0]?.inputSchema).toBeDefined();
		expect(found[1]?.inputSchema).toBeUndefined();
	});
});
