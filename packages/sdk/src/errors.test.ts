import { PayloadTooLarge } from "@sugabots/contracts/http";
import { describe, expect, it } from "vitest";
import { failureFromResponse, isApiFailure } from "./errors.ts";

describe("a refusal that never reached the API", () => {
	it("says an upload was too large for the web server in front of Sugabots", () => {
		const failure = failureFromResponse("<html>413 Request Entity Too Large</html>", 413);

		expect(failure).toBeInstanceOf(PayloadTooLarge);
		expect(failure.message).toMatch(/raise the upload limit/);
		expect(failure.message).not.toContain("<html>");
	});

	it("keeps the API's own words for a file over the API's limit", () => {
		const userMessage = "The file exceeds the configured limit";
		const failure = failureFromResponse(
			{
				_tag: "PayloadTooLarge",
				message: userMessage,
			},
			413,
		);

		expect(isApiFailure(failure)).toBe(true);
		expect(failure.message).toBe(userMessage);
	});
});
