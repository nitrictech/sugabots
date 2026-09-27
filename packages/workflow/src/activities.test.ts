import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Activities } from "./activities.ts";

const activities = Activities.make<{ readonly thread: string }>()({
	start: { execute: () => Effect.void },
	model: {
		success: Schema.String,
		execute: ({ thread }, key) => Effect.succeed(`${thread}:${key}`),
	},
});

describe("activity definitions", () => {
	it("names an activity by its definition and key", () => {
		expect(activities.activity("start", { thread: "t" }).name).toBe("start");
		expect(activities.activity("model", { thread: "t" }, 3).name).toBe("model/3");
	});

	it("rebuilds an activity from its full name and the payload", () => {
		const rebuilt = activities.resolve("model/3", { thread: "t" });

		expect(rebuilt?.name).toBe("model/3");
		expect(rebuilt?.successSchema).toBe(Schema.String);
	});

	it("resolves nothing for a name it does not define", () => {
		expect(activities.resolve("unknown/1", { thread: "t" })).toBeUndefined();
	});
});
