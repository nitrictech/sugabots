import { describe, expect, it } from "vitest";
import { failureMessage, NotReadyError } from "./failure.ts";

describe("failureMessage", () => {
	it("distinguishes a workspace that is not ready from a network failure", () => {
		expect(failureMessage(new NotReadyError())).toBe("Your workspace is not ready yet");
	});
});
