import { describe, expect, it } from "vitest";
import { threadTitleFrom, UNTITLED_THREAD } from "./thread-title.ts";

describe("a conversation's title, from what started it", () => {
	it("is the first sentence, without the mentions, capitalised", () => {
		expect(threadTitleFrom("@growth-desk draft the renewal note. Keep it short.")).toBe(
			"Draft the renewal note.",
		);
	});

	it("is kept whole when it fits in a title", () => {
		expect(threadTitleFrom("can you check the renewal numbers for Northwind before Friday?")).toBe(
			"Can you check the renewal numbers for Northwind before Friday?",
		);
	});

	it("is cut to the longest a title may be, with an ellipsis", () => {
		const long =
			"can you check the renewal numbers for Northwind, Brightwater and Fernhill before the board meeting on Friday?";
		const title = threadTitleFrom(long);
		expect(Array.from(title)).toHaveLength(80);
		expect(title).toBe(
			"Can you check the renewal numbers for Northwind, Brightwater and Fernhill befor…",
		);
	});

	it("says it is a new conversation when nothing but mentions started it", () => {
		expect(threadTitleFrom("@growth-desk")).toBe(UNTITLED_THREAD);
	});
});
