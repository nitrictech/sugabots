import { describe, expect, it } from "vitest";
import { threadTitleFrom, UNTITLED_THREAD } from "./thread-title.ts";

describe("a thread's title, from what started it", () => {
	it("is the first sentence, without the mentions, capitalised", () => {
		expect(threadTitleFrom("@growth-desk draft the renewal note. Keep it short.")).toBe(
			"Draft the renewal note.",
		);
	});

	it("is cut to 44 characters with an ellipsis", () => {
		expect(threadTitleFrom("can you check the renewal numbers for Northwind before Friday?")).toBe(
			"Can you check the renewal numbers for Northw…",
		);
	});

	it("says it is a new thread when nothing but mentions started it", () => {
		expect(threadTitleFrom("@growth-desk")).toBe(UNTITLED_THREAD);
	});
});
