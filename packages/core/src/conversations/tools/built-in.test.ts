import { userText } from "@sugabots/errors";
import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import { effectRunner } from "../../database/database.ts";
import { noDatabase } from "../../database/testing.ts";
import { BuiltInTools } from "./built-in.ts";

const run = effectRunner(ManagedRuntime.make(noDatabase));
const fetchPage = async () => ({ ok: false as const, reason: userText`unused` });
const httpClients = { for: () => async () => new Response(null, { status: 503 }) };
const SETTINGS_PAGE = "https://sugabots.example/acme/settings/search";
const braveProvider = {
	resolve: () =>
		Effect.succeed({
			preset: "brave" as const,
			baseUrl: "https://api.search.brave.com/res/v1",
			apiKey: "k",
			configurationUpdatedAt: new Date(),
		}),
};

describe("the built-in tools for a workspace", () => {
	it("always offers web_fetch and web_search, letting them run only with a search provider to call", async () => {
		const without = BuiltInTools.from({
			fetchPage,
			searchProviders: { resolve: () => Effect.undefined },
			httpClients,
		});
		const offline = await run(without.forWorkspace("w1", SETTINGS_PAGE));
		expect(Object.keys(offline.tools)).toEqual(["web_fetch", "web_search"]);
		expect(offline.usable).toEqual([]);

		const withSearch = BuiltInTools.from({
			fetchPage,
			searchProviders: braveProvider,
			httpClients,
		});
		const online = await run(withSearch.forWorkspace("w1", SETTINGS_PAGE));
		expect(Object.keys(online.tools)).toEqual(["web_fetch", "web_search"]);
		expect(online.usable).toEqual(["web_fetch", "web_search"]);
	});

	it("tells the bot what the provider said about a failed search, and where its settings are", async () => {
		const rateLimited = BuiltInTools.from({
			fetchPage,
			searchProviders: braveProvider,
			httpClients: {
				for: () => async () =>
					new Response("Rate limit exceeded. Upgrade your plan for more searches.", {
						status: 429,
					}),
			},
		});
		const { tools } = await run(rateLimited.forWorkspace("w1", SETTINGS_PAGE));

		const callOptions = { toolCallId: "1", messages: [] } as never;
		const result = await tools.web_search?.execute?.(
			{ query: "open bots", count: 1 } as never,
			callOptions,
		);

		expect(result).toEqual({
			ok: false,
			reason: "Brave Search answered HTTP 429",
			providerMessage: "Rate limit exceeded. Upgrade your plan for more searches.",
			settingsPageUrl: SETTINGS_PAGE,
		});
	});
});
