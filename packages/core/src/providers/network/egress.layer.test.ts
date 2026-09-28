import { Cause, ConfigProvider, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { Egress } from "./egress.ts";

/** Runs `use` against `Egress.layer` as `env` configures it, before its clients close. */
function withEgress<A>(env: Record<string, string>, use: (egress: Egress.Interface) => Promise<A>) {
	return Effect.runPromiseExit(
		Effect.flatMap(Egress.Service, (egress) => Effect.promise(() => use(egress))).pipe(
			Effect.provide(
				Egress.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))),
			),
		),
	);
}

/** What `promise` rejects with, including the causes a failed `fetch` wraps it in. */
async function rejection(promise: Promise<unknown>) {
	try {
		await promise;
		return "resolved";
	} catch (error) {
		const messages: string[] = [];
		for (let current: unknown = error; current instanceof Error; current = current.cause) {
			messages.push(current.message);
		}
		return messages.join(" <- ");
	}
}

const PRIVATE = /private or reserved network/;
const privateProvider = "https://127.0.0.1/v1";
const privatePage = "https://127.0.0.1:1/";

describe("Egress.layer", () => {
	it.each([
		["outside production", {}, "resolved"],
		["in production", { NODE_ENV: "production" }, PRIVATE],
		[
			"in production when allowed",
			{ NODE_ENV: "production", ALLOW_PRIVATE_MODEL_PROVIDER_NETWORK: "true" },
			"resolved",
		],
		["outside production when refused", { ALLOW_PRIVATE_MODEL_PROVIDER_NETWORK: "false" }, PRIVATE],
	])("lets model providers reach a private network %s as configured", async (_, env, expected) => {
		const exit = await withEgress(env, (egress) =>
			rejection(Effect.runPromise(egress.validateProviderUrl(privateProvider))),
		);

		expect(Exit.isSuccess(exit) && exit.value).toMatch(expected);
	});

	it("keeps web_fetch off private networks unless allowed", async () => {
		const refused = await withEgress({}, (egress) => rejection(egress.webFetch(privatePage)));
		const allowed = await withEgress({ ALLOW_PRIVATE_WEB_FETCH_NETWORK: "true" }, (egress) =>
			rejection(egress.webFetch(privatePage)),
		);

		expect(Exit.isSuccess(refused) && refused.value).toMatch(PRIVATE);
		// Allowed through, so it fails at the connection instead: nothing listens on port 1.
		expect(Exit.isSuccess(allowed) && allowed.value).not.toMatch(PRIVATE);
	});

	it.each([
		["ALLOW_PRIVATE_MODEL_PROVIDER_NETWORK", "maybe"],
		["ALLOW_PRIVATE_WEB_FETCH_NETWORK", "ture"],
	])("refuses to start when %s is not a boolean", async (name, value) => {
		const exit = await withEgress({ [name]: value }, async () => undefined);

		expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toMatch(name);
	});
});
