import { execFileSync } from "node:child_process";
import { DateTime } from "effect";
import { describe, expect, it } from "vitest";
import { gitEnvironment } from "./tools.ts";

/** What git sends where, given a sandbox command's sign-in, asked of real git. */
describe("a sandbox command's sign-in to the pod's repositories", () => {
	const environment = gitEnvironment([
		{ account: "acme", token: "acme-token", expiresAt: DateTime.makeUnsafe("2099-01-01") },
		{ account: "globex", token: "globex-token", expiresAt: DateTime.makeUnsafe("2099-01-01") },
	]);

	const headerFor = (url: string) => {
		try {
			return execFileSync("git", ["config", "--get-urlmatch", "http.extraHeader", url], {
				encoding: "utf8",
				env: {
					PATH: process.env.PATH,
					HOME: "/nonexistent",
					GIT_CONFIG_NOSYSTEM: "1",
					...environment,
				},
			}).trim();
		} catch {
			return undefined;
		}
	};
	const basic = (token: string) =>
		`Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

	it("sends each account's token to that account's repositories only", () => {
		expect(headerFor("https://github.com/acme/web.git")).toBe(basic("acme-token"));
		expect(headerFor("https://github.com/globex/api")).toBe(basic("globex-token"));
		expect(headerFor("https://github.com/someone-else/repo.git")).toBeUndefined();
		expect(headerFor("https://example.com/acme/web.git")).toBeUndefined();
	});

	it("gives gh a token only when the pod's repositories are on one account", () => {
		const one = gitEnvironment([
			{ account: "acme", token: "acme-token", expiresAt: DateTime.makeUnsafe("2099-01-01") },
		]);

		expect(environment.GH_TOKEN).toBeUndefined();
		expect(one.GH_TOKEN).toBe("acme-token");
		expect(gitEnvironment([])).toEqual({});
	});
});
