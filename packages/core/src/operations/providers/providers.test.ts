import type { NewModelProvider } from "@sugabots/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unique } from "../../authentication/seed.test-support.ts";
import { closeDatabase } from "../../database/testing.ts";
import {
	authenticators,
	buildWorld,
	everyKindOfPrincipal,
	principals,
	type World,
} from "../../proofs/world.test-support.ts";
import { createEgressUrlValidator, Egress, urlValidation } from "../../providers/network/egress.ts";
import { unimplemented } from "../../testing.ts";
import { type CallOperation, servedOperations } from "../testing.ts";

/**
 * What the providers operations do for a bot beyond the rule
 * `permissions.test.ts` states for each: a Personal Assistant acts for its
 * member, who is who connected what it adds. Every provider answers an empty
 * model list.
 *
 * The world is `buildWorld`'s: in workspace A, the admin has a Personal
 * Assistant.
 */
describe("the providers operations, for a bot acting for its member", () => {
	let world: World;
	let call: CallOperation;
	let as: ReturnType<typeof principals>;
	let a: World["a"];
	/** Every principal the cases call for, in workspace A unless its name says otherwise. */
	let who: Awaited<ReturnType<typeof everyKindOfPrincipal>>;

	beforeAll(async () => {
		world = await buildWorld();
		a = world.a;
		call = await servedOperations({
			egress: unimplemented(Egress.Service, {
				providers: { for: () => async () => Response.json({ data: [] }) },
				validateProviderUrl: urlValidation(
					createEgressUrlValidator({
						allowPrivateNetwork: true,
						lookup: async () => [{ address: "93.184.216.34", family: 4 }],
					}),
				),
				oauth: async () => new Response(null, { status: 503 }),
				webFetch: async () => new Response(null, { status: 503 }),
			}),
		});
		as = principals(await authenticators());
		who = await everyKindOfPrincipal(world, as);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** A custom model provider no other in the workspace is named like. */
	const gateway = (apiKey?: string): NewModelProvider => ({
		name: `Gateway ${unique()}`,
		baseUrl: "https://models.example/v1",
		apiFormat: "openai",
		customHeaders: [],
		...(apiKey === undefined ? {} : { apiKey }),
	});

	it("records the member a Personal Assistant acts for as who connected the provider it adds", async () => {
		const added = await call(who.adminsAssistant, "modelProviders.create", {
			workspace: a.workspace,
			provider: gateway("gateway-key"),
		});

		expect(added).toMatchObject({ hasApiKey: true, connectedBy: { id: a.admin } });
	});
});
