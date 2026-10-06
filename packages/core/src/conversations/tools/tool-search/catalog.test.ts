import { describe, expect, it } from "vitest";
import { type CatalogEntry, catalogListing, LISTING_CHARACTERS, searchCatalog } from "./catalog.ts";

const entry = (
	handle: string,
	name: string,
	{ description = "", properties = {} as Record<string, object>, required = [] as string[] } = {},
): CatalogEntry => ({
	key: `${handle}__${name}`,
	handle,
	remoteToolName: name,
	description,
	inputSchema: { type: "object", properties, required },
});

describe("the listing of connection tools", () => {
	it("stays within its budget however many tools its connections have, and says how many it left out", () => {
		const many = (handle: string) =>
			Array.from({ length: 371 }, (_, index) =>
				entry(handle, `run_report_${String(index).padStart(3, "0")}`),
			);
		const listing = catalogListing([...many("reports"), ...many("sales")]);

		expect(listing.length).toBeLessThanOrEqual(LISTING_CHARACTERS);
		expect(listing).toMatch(
			/^- reports \(371 tools\): reports__run_report_000, .*, and \d+ more$/m,
		);
		expect(listing).toMatch(/^- sales \(371 tools\): sales__run_report_000, .*, and \d+ more$/m);
	});

	it("names every tool of a small connection by the full name it is called by", () => {
		expect(catalogListing([entry("notes", "list_notes")])).toBe(
			"- notes (1 tool): notes__list_notes",
		);
	});
});

describe("searching connection tools", () => {
	it("finds a tool by a plural of a word in its name, ignoring words every description has", () => {
		const entries = [
			entry("tracker", "list_issue", { description: "Lists the issues in a project." }),
			entry("tracker", "create_project", { description: "Creates a project for the team." }),
		];

		expect(searchCatalog(entries, "the open issues").map((found) => found.tool)).toEqual([
			"tracker__list_issue",
		]);
	});

	it("gives the best matches' schemas, and only what the others require", () => {
		const entries = ["run_report", "run_report_export", "run_report_schedule"].map((name) =>
			entry("reports", name, {
				description: "Runs a report. Takes a while.",
				properties: { query: { type: "string" } },
				required: ["query"],
			}),
		);

		const found = searchCatalog(entries, "run report");

		expect(found.slice(0, 2).every((match) => "inputSchema" in match)).toBe(true);
		expect(found[2]).toEqual({
			tool: "reports__run_report_schedule",
			description: "Runs a report.",
			required: ["query"],
		});
	});
});
