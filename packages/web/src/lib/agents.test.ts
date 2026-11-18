import { describe, expect, it } from "vitest";
import { findBot } from "@/lib/agents.ts";
import { agents, personalAssistant } from "@/test-api.tsx";

describe("findBot", () => {
	const someoneElses = {
		...personalAssistant,
		id: "0199a3a0-0000-7000-8000-0000000000be",
		assistant: false,
	};

	it("finds the person's own Personal Assistant by the handle every assistant shares", () => {
		expect(findBot([someoneElses, ...agents, personalAssistant], "personal-assistant")).toBe(
			personalAssistant,
		);
	});

	it("never finds someone else's Personal Assistant", () => {
		expect(findBot([someoneElses, ...agents], "personal-assistant")).toBeUndefined();
	});
});
