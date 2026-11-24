import { randomUUID } from "node:crypto";
import type { NewModelProvider } from "@sugabots/contracts";
import type { InputOf, OperationName } from "@sugabots/contracts/operations";
import { eq } from "drizzle-orm";
import { Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	seedBot,
	seedMember,
	seedProjectChat,
	unique,
} from "../../authentication/seed.test-support.ts";
import { workspace } from "../../database/schema.ts";
import { closeDatabase, onDatabase } from "../../database/testing.ts";
import type { Principal } from "../../principal.ts";
import {
	authenticators,
	buildWorld,
	principals,
	type World,
} from "../../proofs/world.test-support.ts";
import { createEgressUrlValidator, Egress, urlValidation } from "../../providers/network/egress.ts";
import { type CallOperation, servedOperations } from "../testing.ts";

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
	let who: Awaited<ReturnType<typeof principalsInA>>;

	const principalsInA = async () => {
		const outsider = await seedMember(world.b.workspace, "editor");
		const adminsAssistant = await seedBot(a.workspace, {
			assistantOf: a.admin,
			visibility: "personal",
		});
		const adminsAssistantChat = await seedProjectChat(
			a.workspace,
			adminsAssistant.defaultProject,
			a.admin,
		);
		return {
			owner: await as.member(a.owner),
			admin: await as.member(a.admin),
			ed: await as.member(a.ed),
			vi: await as.member(a.vi),
			outsider: await as.member(outsider),
			/** Pub answering Ed in J's chat: chat bounds. */
			pubForEd: await as.botFor(a.ed, a.pub.id, a.chat),
			/** Pub answering an admin in J's chat: chat bounds. */
			pubForAdmin: await as.botFor(a.admin, a.pub.id, a.chat),
			/** Ed's Personal Assistant in its own chat: member bounds. */
			edsAssistant: await as.botFor(a.ed, a.assistant.id, a.assistantChat),
			/** An admin's Personal Assistant in its own chat: member bounds. */
			adminsAssistant: await as.botFor(a.admin, adminsAssistant.id, adminsAssistantChat),
			run: (await as.run(a.workspace, a.project, a.pub.id)).principal,
			webhook: await as.webhook(a.workspace, a.project),
			computerSleep: (await as.computerSleep(a.workspace, a.project)).principal,
			compaction: await as.compaction(a.chat, a.pub.id),
			page: await as.page(a.chat),
		};
	};

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
		who = await principalsInA();
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** What calling `name` with `input` for `principal` came to: "ok", or its error's tag. */
	const tried = <Name extends OperationName>(
		principal: Principal,
		name: Name,
		input: InputOf<Name>,
	): Promise<string> =>
		call(principal, name, input).then(
			() => "ok",
			(failure: { readonly _tag: string }) => failure._tag,
		);

	/** What `attempt` came to for each principal of `principals`, by its name. */
	const outcomes = async <Key extends string>(
		principals: Record<Key, Principal>,
		attempt: (principal: Principal) => Promise<string>,
	) => {
		const entries = await Promise.all(
			Object.entries<Principal>(principals).map(async ([key, principal]) => [
				key,
				await attempt(principal),
			]),
		);
		return Object.fromEntries(entries) as Record<Key, string>;
	};

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
			tried(principal, "modelProviders.create", { workspace: a.workspace, provider: gateway() });

		expect(
			await outcomes(
				{
					owner: who.owner,
					admin: who.admin,
					editor: who.ed,
					viewer: who.vi,
					outsider: who.outsider,
					adminsBotInChatBounds: who.pubForAdmin,
					adminsAssistant: who.adminsAssistant,
					editorsAssistant: who.edsAssistant,
					run: who.run,
					webhook: who.webhook,
					computerSleep: who.computerSleep,
					compaction: who.compaction,
					page: who.page,
				},
				create,
			),
		).toEqual({
			owner: "ok",
			admin: "ok",
			editor: "ActionForbidden",
			viewer: "ActionForbidden",
			outsider: "ResourceHidden",
			adminsBotInChatBounds: "ActionForbidden",
			adminsAssistant: "ok",
			editorsAssistant: "ActionForbidden",
			run: "ActionForbidden",
			webhook: "ActionForbidden",
			computerSleep: "ActionForbidden",
			compaction: "ActionForbidden",
			page: "ActionForbidden",
		});
	});

	it("refuses every way of managing providers before looking for what it names", async () => {
		const reference = { workspace: a.workspace };
		const provider = { ...reference, providerId: randomUUID() };
		const model = { ...provider, modelId: randomUUID() };
		const managing: Record<string, (principal: Principal) => Promise<string>> = {
			"modelProviders.list": (p) => tried(p, "modelProviders.list", reference),
			"modelProviders.setDefaultModel": (p) =>
				tried(p, "modelProviders.setDefaultModel", { ...reference, model: "some-model" }),
			"modelProviders.update": (p) =>
				tried(p, "modelProviders.update", { ...provider, changes: { active: false } }),
			"modelProviders.remove": (p) => tried(p, "modelProviders.remove", provider),
			"modelProviders.switchOff": (p) =>
				tried(p, "modelProviders.switchOff", { ...provider, moveBots: [] }),
			"modelProviders.test": (p) => tried(p, "modelProviders.test", provider),
			"modelProviders.startSignIn": (p) => tried(p, "modelProviders.startSignIn", provider),
			"modelProviders.completeSignIn": (p) =>
				tried(p, "modelProviders.completeSignIn", { ...provider, attempt: "sealed" }),
			"modelProviders.signOut": (p) => tried(p, "modelProviders.signOut", provider),
			"modelProviders.discoverModels": (p) => tried(p, "modelProviders.discoverModels", provider),
			"modelProviders.addModel": (p) =>
				tried(p, "modelProviders.addModel", {
					...provider,
					model: { modelId: "some-model", capabilities: [] },
				}),
			"modelProviders.updateModel": (p) =>
				tried(p, "modelProviders.updateModel", { ...model, changes: { enabled: false } }),
			"modelProviders.switchOffModel": (p) => tried(p, "modelProviders.switchOffModel", model),
			"searchProviders.get": (p) => tried(p, "searchProviders.get", reference),
			"searchProviders.replace": (p) =>
				tried(p, "searchProviders.replace", { ...reference, builtIn: "brave" }),
			"searchProviders.update": (p) =>
				tried(p, "searchProviders.update", { ...reference, changes: { enabled: false } }),
			"searchProviders.remove": (p) => tried(p, "searchProviders.remove", reference),
			"searchProviders.test": (p) => tried(p, "searchProviders.test", reference),
		};

		for (const [name, attempt] of Object.entries(managing)) {
			expect({
				name,
				outcomes: await outcomes(
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
					editor: "ActionForbidden",
					outsider: "ResourceHidden",
					adminsBotInChatBounds: "ActionForbidden",
					run: "ActionForbidden",
				},
			});
		}
	});

	it("tells every member which models are offered and whether the web tools are on, and a bot only in member bounds", async () => {
		const reads = ["modelProviders.listEnabledModels", "searchProviders.webAccess"] as const;
		for (const name of reads) {
			expect({
				name,
				outcomes: await outcomes(
					{
						viewer: who.vi,
						editor: who.ed,
						outsider: who.outsider,
						botInChatBounds: who.pubForEd,
						editorsAssistant: who.edsAssistant,
						run: who.run,
						webhook: who.webhook,
						computerSleep: who.computerSleep,
						page: who.page,
					},
					(principal) => tried(principal, name, { workspace: a.workspace }),
				),
			}).toEqual({
				name,
				outcomes: {
					viewer: "ok",
					editor: "ok",
					outsider: "ResourceHidden",
					botInChatBounds: "ActionForbidden",
					editorsAssistant: "ok",
					run: "ActionForbidden",
					webhook: "ActionForbidden",
					computerSleep: "ActionForbidden",
					page: "ActionForbidden",
				},
			});
		}
	});

	it("takes the workspace by its slug, and hides a slug no workspace has", async () => {
		const [found] = await onDatabase((db) =>
			db.select({ slug: workspace.slug }).from(workspace).where(eq(workspace.id, a.workspace)),
		);

		expect(
			await tried(who.admin, "modelProviders.listEnabledModels", { workspace: found?.slug ?? "" }),
		).toBe("ok");
		expect(await tried(who.admin, "modelProviders.list", { workspace: `nobody-${unique()}` })).toBe(
			"ResourceHidden",
		);
	});

	it("records the member a Personal Assistant acts for as who connected the provider it adds", async () => {
		const added = await call(who.adminsAssistant, "modelProviders.create", {
			workspace: a.workspace,
			provider: gateway("gateway-key"),
		});

		expect(added).toMatchObject({ hasApiKey: true, connectedBy: { id: a.admin } });
	});
});
