import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { call } from "./github.ts";

describe("GitHub API errors", () => {
	it.each([
		{
			name: "plain-string validation errors",
			body: { message: "Validation Failed", errors: ["Line must be part of the diff"] },
			reason: "Validation Failed: Line must be part of the diff",
		},
		{
			name: "object validation errors",
			body: { message: "Validation Failed", errors: [{ message: "Path is required" }] },
			reason: "Validation Failed: Path is required",
		},
		{
			name: "mixed validation errors",
			body: {
				message: "Validation Failed",
				errors: ["Line must be part of the diff", { message: "Path is required" }, {}],
			},
			reason: "Validation Failed: Line must be part of the diff: Path is required",
		},
		{
			name: "a message without validation errors",
			body: { message: "Validation Failed" },
			reason: "Validation Failed",
		},
		{
			name: "the HTTP status text for an unrecognized error body",
			body: { unexpected: true },
			reason: "Unprocessable Entity",
		},
	])("reports $name", async ({ body, reason }) => {
		const failure = await Effect.runPromise(
			call(
				async () => Response.json(body, { status: 422, statusText: "Unprocessable Entity" }),
				"POST",
				"/repos/acme/web/pulls/5/reviews",
				{ bearer: "installation-token" },
			).pipe(Effect.flip),
		);
		expect(failure).toMatchObject({ _tag: "GitHubRequestFailed", status: 422, reason });
	});
});
