import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import { effectRunner } from "../../database/database.ts";
import { noDatabase } from "../../database/testing.ts";
import { builtInTools } from "./built-in.ts";

const run = effectRunner(ManagedRuntime.make(noDatabase));
const fetchPage = async () => ({ ok: false as const, reason: "unused" });
const httpClients = { for: () => async () => new Response(null, { status: 503 }) };

describe("the built-in tools for a workspace", () => {
	it("offers web_fetch always and web_search only with a search provider to call", async () => {
		const without = builtInTools({
			fetchPage,
			searchProviders: { resolve: () => Effect.undefined },
			httpClients,
		});
		expect(Object.keys(await run(without.forWorkspace("w1")))).toEqual(["web_fetch"]);

		const withSearch = builtInTools({
			fetchPage,
			searchProviders: {
				resolve: () =>
					Effect.succeed({
						preset: "brave" as const,
						baseUrl: "https://api.search.brave.com/res/v1",
						apiKey: "k",
						configurationUpdatedAt: new Date(),
					}),
			},
			httpClients,
		});
		expect(Object.keys(await run(withSearch.forWorkspace("w1")))).toEqual([
			"web_fetch",
			"web_search",
		]);
	});
});
