import { describe, expect, it } from "vitest";
import { stepLabel, waitingText } from "./tool-names.ts";

describe("tool names", () => {
	it("turns a tool key into a phrase", () => {
		expect(stepLabel("sentry__search_issues")).toBe("Search issues");
		expect(stepLabel("linear__searchIssues")).toBe("Search issues");
		expect(stepLabel("web_fetch")).toBe("Read web pages");
	});

	it("says what a chat is waiting to do, for a connection's tool or a built-in one", () => {
		expect(waitingText("linear__get_issue")).toBe("Waiting to get issue in Linear");
		expect(waitingText("web_fetch")).toBe("Waiting to read web pages");
	});
});
