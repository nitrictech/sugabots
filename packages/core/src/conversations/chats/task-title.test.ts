import { describe, expect, it } from "vitest";
import { taskTitleFrom, UNTITLED_TASK } from "./task-title.ts";

describe("a conversation's title, from what started it", () => {
	it("is the first sentence, without the mentions, capitalised", () => {
		expect(taskTitleFrom("@growth-desk draft the renewal note. Keep it short.")).toBe(
			"Draft the renewal note.",
		);
	});

	it("is cut to 44 characters with an ellipsis", () => {
		expect(taskTitleFrom("can you check the renewal numbers for Northwind before Friday?")).toBe(
			"Can you check the renewal numbers for Northw…",
		);
	});

	it("says it is a new conversation when nothing but mentions started it", () => {
		expect(taskTitleFrom("@growth-desk")).toBe(UNTITLED_TASK);
	});
});
