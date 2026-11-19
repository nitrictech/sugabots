import { Conflict } from "@sugabots/contracts/http";
import { userText } from "@sugabots/errors";
import { describe, expect, it } from "vitest";
import { failureMessage, NotReadyError } from "./failure.ts";

describe("failureMessage", () => {
	const conflict = new Conflict({ message: userText`That name is taken` });

	it("gives the API's message, or the screen's own wording for that failure", () => {
		expect(failureMessage(conflict)).toBe("That name is taken");
		expect(failureMessage(conflict, { Conflict: "A project already has that name" })).toBe(
			"A project already has that name",
		);
	});

	it("says a failure that never reached the API could not reach it, whatever it was", () => {
		expect(failureMessage(new TypeError("Failed to fetch"))).toBe("Could not reach the API");
		expect(failureMessage(new TypeError("Failed to fetch"), { Conflict: "Taken" })).toBe(
			"Could not reach the API",
		);
	});

	it("says a workspace still loading is not ready, rather than unreachable", () => {
		expect(failureMessage(new NotReadyError())).toBe("Your workspace is not ready yet");
	});
});
