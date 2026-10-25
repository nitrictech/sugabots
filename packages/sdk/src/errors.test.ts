import { PayloadTooLarge } from "@sugabots/contracts/http";
import { describe, expect, it } from "vitest";
import { failureFromResponse, isApiFailure } from "./errors.ts";

describe("a refusal that never reached the API", () => {
	it("says an upload was too large for the web server in front of Sugabots", () => {
		const failure = failureFromResponse("<html>413 Request Entity Too Large</html>", 413);

		expect(failure).toBeInstanceOf(PayloadTooLarge);
		expect(failure.message).toBe(
			"Too large for this server to accept. Whoever runs your Sugabots can raise the upload limit on the web server in front of it",
		);
	});

	it("keeps the API's own words for a file over the API's limit", () => {
		const failure = failureFromResponse(
			{
				_tag: "PayloadTooLarge",
				message: "The file is larger than 30 MB, the most that can be kept",
			},
			413,
		);

		expect(isApiFailure(failure)).toBe(true);
		expect(failure.message).toBe("The file is larger than 30 MB, the most that can be kept");
	});
});
