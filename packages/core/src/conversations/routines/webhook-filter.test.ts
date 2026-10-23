import type { WebhookCondition } from "@sugabots/contracts";
import { describe, expect, it } from "vitest";
import { meetsFilter } from "./webhook-filter.ts";

/** What Linear sends when an issue is created, cut down to what the tests read. */
const linearIssueCreated = {
	action: "create",
	type: "Issue",
	data: { id: "ISS-1", priority: 2, labels: [{ name: "bug" }, { name: "10x" }] },
};

const newIssueLabelled10x: WebhookCondition[] = [
	{ path: "type", oneOf: ["Issue"] },
	{ path: "action", oneOf: ["create"] },
	{ path: "data.labels.name", oneOf: ["10x"] },
];

describe("a webhook trigger's filter", () => {
	it("lets every call through when there is none", () => {
		expect(meetsFilter(undefined, linearIssueCreated)).toBe(true);
		expect(meetsFilter([], "not even an object")).toBe(true);
	});

	it("lets through a call meeting every condition, finding the label among others", () => {
		expect(meetsFilter(newIssueLabelled10x, linearIssueCreated)).toBe(true);
	});

	it.each([
		["a different action", { ...linearIssueCreated, action: "update" }],
		["no such label", { ...linearIssueCreated, data: { labels: [{ name: "bug" }] } }],
		["no labels at all", { ...linearIssueCreated, data: { labels: [] } }],
		["a body that is not an object", "create"],
		["no body", null],
	])("turns away %s", (_, payload) => {
		expect(meetsFilter(newIssueLabelled10x, payload)).toBe(false);
	});

	it("accepts any one of a condition's values", () => {
		const filter = [{ path: "action", oneOf: ["create", "update"] }];
		expect(meetsFilter(filter, { action: "update" })).toBe(true);
		expect(meetsFilter(filter, { action: "remove" })).toBe(false);
	});

	it("compares numbers and booleans as the text they print as", () => {
		const filter = [
			{ path: "data.priority", oneOf: ["2"] },
			{ path: "data.archived", oneOf: ["false"] },
		];
		expect(meetsFilter(filter, { data: { priority: 2, archived: false } })).toBe(true);
		expect(meetsFilter(filter, { data: { priority: 3, archived: false } })).toBe(false);
	});

	it("does not match an object, or a key the body only inherits", () => {
		expect(meetsFilter([{ path: "data", oneOf: ["[object Object]"] }], linearIssueCreated)).toBe(
			false,
		);
		expect(meetsFilter([{ path: "constructor.name", oneOf: ["Object"] }], {})).toBe(false);
	});
});
