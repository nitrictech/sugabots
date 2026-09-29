import { describe, expect, it } from "vitest";
import { stepLabel } from "./tool-names.ts";

describe("tool names", () => {
	it("turns a tool key into a phrase", () => {
		expect(stepLabel("sentry__search_issues")).toBe("Search issues");
		expect(stepLabel("linear__searchIssues")).toBe("Search issues");
		expect(stepLabel("web_fetch")).toBe("Read web pages");
	});
});
