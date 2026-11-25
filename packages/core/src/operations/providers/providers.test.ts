import { randomUUID } from "node:crypto";
import type { NewModelProvider } from "@sugabots/contracts";
import { Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unique } from "../../authentication/seed.test-support.ts";
import { closeDatabase } from "../../database/testing.ts";
import type { Principal } from "../../principal.ts";
import {
	authenticators,
	buildWorld,
	everyKindOfPrincipal,
	outcomesFor,
	principals,
	type World,
} from "../../proofs/world.test-support.ts";
import { createEgressUrlValidator, Egress, urlValidation } from "../../providers/network/egress.ts";
import { type CallOperation, operationOutcome, servedOperations } from "../testing.ts";

/**
 * The providers operations, each called for every kind of principal through
 * the registry, as an entrypoint calls them, with every provider answering
 * an empty model list. What each comes to is "ok" or the tag of its refusal:
 * hidden where the principal isn't in the workspace, forbidden where it is but
 * may not act. Who may do what in detail is the provers' tests'; the
 * providers' own rules are `providers/model-providers/` and
 * `providers/search-providers/`'.
 *
 * The world is `buildWorld`'s: in workspace A, Ed is an editor who made the
 * public bot Pub and has a Personal Assistant, and Vi is a viewer.
 */
describe("the providers operations, for each kind of principal", () => {
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
			egress: Layer.succeed(Egress.Service, {
				providers: { for: () => async () => Response.json({ data: [] }) },
				validateProviderUrl: urlValidation(createEgressUrlValidator({ allowPrivateNetwork: true })),
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

	it("lets the owner and admins manage the workspace's providers, and a bot only in member bounds", async () => {
		const create = (principal: Principal) =>
			operationOutcome(call, principal, "modelProviders.create", {
				workspace: a.workspace,
				provider: gateway(),
			});

		expect(
			await outcomesFor(
				{
					admin: who.admin,
					outsider: who.outsider,
					adminsBotInChatBounds: who.pubForAdmin,
				},
				create,
			),
		).toEqual({
			admin: "ok",
			outsider: "ResourceHidden",
			adminsBotInChatBounds: "ActionForbidden",
		});
	});

	it("refuses every way of managing providers before looking for what it names", async () => {
		const reference = { workspace: a.workspace };
		const provider = { ...reference, providerId: randomUUID() };
		const model = { ...provider, modelId: randomUUID() };
		const managing: Record<string, (principal: Principal) => Promise<string>> = {
			"modelProviders.list": (p) => operationOutcome(call, p, "modelProviders.list", reference),
			"modelProviders.setDefaultModel": (p) =>
				operationOutcome(call, p, "modelProviders.setDefaultModel", {
					...reference,
					model: "some-model",
				}),
			"modelProviders.update": (p) =>
				operationOutcome(call, p, "modelProviders.update", {
					...provider,
					changes: { active: false },
				}),
			"modelProviders.remove": (p) => operationOutcome(call, p, "modelProviders.remove", provider),
			"modelProviders.switchOff": (p) =>
				operationOutcome(call, p, "modelProviders.switchOff", { ...provider, moveBots: [] }),
			"modelProviders.test": (p) => operationOutcome(call, p, "modelProviders.test", provider),
			"modelProviders.startSignIn": (p) =>
				operationOutcome(call, p, "modelProviders.startSignIn", provider),
			"modelProviders.completeSignIn": (p) =>
				operationOutcome(call, p, "modelProviders.completeSignIn", {
					...provider,
					attempt: "sealed",
				}),
			"modelProviders.signOut": (p) =>
				operationOutcome(call, p, "modelProviders.signOut", provider),
			"modelProviders.discoverModels": (p) =>
				operationOutcome(call, p, "modelProviders.discoverModels", provider),
			"modelProviders.addModel": (p) =>
				operationOutcome(call, p, "modelProviders.addModel", {
					...provider,
					model: { modelId: "some-model", capabilities: [] },
				}),
			"modelProviders.updateModel": (p) =>
				operationOutcome(call, p, "modelProviders.updateModel", {
					...model,
					changes: { enabled: false },
				}),
			"modelProviders.switchOffModel": (p) =>
				operationOutcome(call, p, "modelProviders.switchOffModel", model),
			"searchProviders.get": (p) => operationOutcome(call, p, "searchProviders.get", reference),
			"searchProviders.replace": (p) =>
				operationOutcome(call, p, "searchProviders.replace", { ...reference, builtIn: "brave" }),
			"searchProviders.update": (p) =>
				operationOutcome(call, p, "searchProviders.update", {
					...reference,
					changes: { enabled: false },
				}),
			"searchProviders.remove": (p) =>
				operationOutcome(call, p, "searchProviders.remove", reference),
			"searchProviders.test": (p) => operationOutcome(call, p, "searchProviders.test", reference),
		};

		for (const [name, attempt] of Object.entries(managing)) {
			const invalidAttempt =
				name === "modelProviders.completeSignIn" ? "ProviderSignInAttemptInvalid" : undefined;
			expect({
				name,
				outcomes: await outcomesFor(
					{
						editor: who.ed,
						outsider: who.outsider,
						adminsBotInChatBounds: who.pubForAdmin,
						run: who.run,
					},
					attempt,
				),
			}).toEqual({
				name,
				outcomes: {
					editor: invalidAttempt ?? "ActionForbidden",
					outsider: invalidAttempt ?? "ResourceHidden",
					adminsBotInChatBounds: invalidAttempt ?? "ActionForbidden",
					run: invalidAttempt ?? "ActionForbidden",
				},
			});
		}
	});

	it("tells every member which models are offered and whether the web tools are on, and a bot only in member bounds", async () => {
		const reads = ["modelProviders.listEnabledModels", "searchProviders.webAccess"] as const;
		for (const name of reads) {
			expect({
				name,
				outcomes: await outcomesFor(
					{
						viewer: who.vi,
						outsider: who.outsider,
						botInChatBounds: who.pubForEd,
					},
					(principal) => operationOutcome(call, principal, name, { workspace: a.workspace }),
				),
			}).toEqual({
				name,
				outcomes: {
					viewer: "ok",
					outsider: "ResourceHidden",
					botInChatBounds: "ActionForbidden",
				},
			});
		}
	});

	it("records the member a Personal Assistant acts for as who connected the provider it adds", async () => {
		const added = await call(who.adminsAssistant, "modelProviders.create", {
			workspace: a.workspace,
			provider: gateway("gateway-key"),
		});

		expect(added).toMatchObject({ hasApiKey: true, connectedBy: { id: a.admin } });
	});
});
