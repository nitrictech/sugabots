import type { InputOf, RequestOperationName } from "@sugabots/contracts/operations";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	seedBot,
	seedMember,
	seedProjectChat,
	unique,
} from "../../authentication/seed.test-support.ts";
import { bot, modelProvider, providerModel } from "../../database/schema.ts";
import { closeDatabase, onDatabase } from "../../database/testing.ts";
import type { Principal } from "../../principal.ts";
import {
	authenticators,
	buildWorld,
	principals,
	type World,
} from "../../proofs/world.test-support.ts";
import { type CallOperation, servedOperations } from "../testing.ts";

/** The model workspace A offers, which the bots these cases make run on. */
const OFFERED = "offered-model";

/**
 * The bots operations, each called for every kind of principal through the
 * registry, as an entrypoint calls them. What each comes to is "ok" or the
 * tag of its refusal: hidden where the principal doesn't see the bot or the
 * workspace, forbidden where it does but may not act. Who may do what in
 * detail is the provers' tests'; the bots' own rules are `workspaces/bots/`'.
 *
 * The world is `buildWorld`'s: in workspace A, Ed (an editor) made the public
 * bot Pub, which leads the private project J, and his personal bot Personal,
 * and has a Personal Assistant; Erin is an editor, Vi a viewer.
 */
describe("the bots operations, for each kind of principal", () => {
	let world: World;
	let call: CallOperation;
	let as: ReturnType<typeof principals>;
	let a: World["a"];
	let who: Awaited<ReturnType<typeof everyPrincipal>>;

	const everyPrincipal = async () => {
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
			erin: await as.member(a.erin),
			outsider: await as.member(outsider),
			/** Pub answering Ed in J's chat: chat bounds, J. */
			pubForEd: await as.botFor(a.ed, a.pub.id, a.chat),
			/** Pub answering Ed in one of its own chats. */
			pubInOwnChats: await as.botFor(a.ed, a.pub.id, a.pubChat),
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
		call = await servedOperations();
		as = principals(await authenticators());
		who = await everyPrincipal();
		const [provider] = await onDatabase((db) =>
			db
				.insert(modelProvider)
				.values({
					workspaceId: a.workspace,
					name: "Models",
					baseUrl: "https://models.example/v1",
					apiFormat: "openai",
					active: true,
				})
				.returning(),
		);
		if (!provider) throw new Error("could not create the model provider");
		await onDatabase((db) =>
			db.insert(providerModel).values({
				workspaceId: a.workspace,
				providerId: provider.id,
				modelId: OFFERED,
				enabled: true,
				source: "manual",
			}),
		);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** What calling `name` with `input` for `principal` came to: "ok", or its error's tag. */
	const tried = <Name extends RequestOperationName>(
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

	/** A public bot Erin made, for a case to change or delete. */
	const erinsBot = () => seedBot(a.workspace, { createdById: a.erin });

	describe("reading the workspace's bots", () => {
		it("lists only the identity and restriction permissions of another member's personal bot", async () => {
			await onDatabase((db) =>
				db
					.update(bot)
					.set({
						instructions: "Private instructions",
						description: "Private description",
					})
					.where(eq(bot.id, a.personal.id)),
			);
			const list = (principal: Principal) =>
				call(principal, "bots.list", { workspace: a.workspace });
			const shown = (await list(who.admin)).find(({ id }) => id === a.personal.id);
			expect(shown).toMatchObject({
				id: a.personal.id,
				defaultProjectId: a.personal.defaultProject,
				permissions: { talk: false, delete: true, update: false },
			});
			expect(shown).not.toHaveProperty("instructions");
			expect(shown).not.toHaveProperty("description");
			expect(shown).not.toHaveProperty("model");
			expect((await list(who.ed)).find(({ id }) => id === a.personal.id)).toHaveProperty(
				"instructions",
				"Private instructions",
			);
		});
		it("lists its bots and system bots to its members, and to a bot only in member bounds", async () => {
			for (const name of ["bots.list", "systemBots.list"] as const) {
				expect({
					name,
					outcomes: await outcomes(
						{
							viewer: who.vi,
							outsider: who.outsider,
							botInChatBounds: who.pubForEd,
							botInMemberBounds: who.edsAssistant,
							run: who.run,
							webhook: who.webhook,
							systemWork: who.computerSleep,
							page: who.page,
						},
						(principal) => tried(principal, name, { workspace: a.workspace }),
					),
				}).toEqual({
					name,
					outcomes: {
						viewer: "ok",
						outsider: "ResourceHidden",
						botInChatBounds: "ActionForbidden",
						botInMemberBounds: "ok",
						run: "ActionForbidden",
						webhook: "ActionForbidden",
						systemWork: "ActionForbidden",
						page: "ActionForbidden",
					},
				});
			}
		});
	});

	describe("bots.create", () => {
		it("makes a bot for a member who may, and a bot only in member bounds", async () => {
			const create = (principal: Principal) =>
				tried(principal, "bots.create", {
					workspace: a.workspace,
					name: `Bot ${unique()}`,
					model: OFFERED,
				});

			expect(
				await outcomes(
					{
						editor: who.ed,
						viewer: who.vi,
						outsider: who.outsider,
						botInChatBounds: who.pubForEd,
						editorsAssistant: who.edsAssistant,
						run: who.run,
						webhook: who.webhook,
						page: who.page,
					},
					create,
				),
			).toEqual({
				editor: "ok",
				viewer: "ActionForbidden",
				outsider: "ResourceHidden",
				botInChatBounds: "ActionForbidden",
				editorsAssistant: "ok",
				run: "ActionForbidden",
				webhook: "ActionForbidden",
				page: "ActionForbidden",
			});
		});
	});

	describe("bots.update", () => {
		it("changes a bot for its managers, a bot in member bounds, and itself in its own chats only as its interview does", async () => {
			const rename = (principal: Principal) =>
				tried(principal, "bots.update", {
					botId: a.pub.id,
					changes: { name: `Pub ${unique()}` },
				});

			expect({
				...(await outcomes(
					{
						creator: who.ed,
						admin: who.admin,
						editor: who.erin,
						viewer: who.vi,
						outsider: who.outsider,
						botInChatBounds: who.pubForEd,
						botRenamingItselfInOwnChats: who.pubInOwnChats,
						creatorsAssistant: who.edsAssistant,
						run: who.run,
						webhook: who.webhook,
						computerSleep: who.computerSleep,
						compaction: who.compaction,
						page: who.page,
					},
					rename,
				)),
				botWritingItsInstructionsInOwnChats: await tried(who.pubInOwnChats, "bots.update", {
					botId: a.pub.id,
					changes: { instructions: "Sort the inbox." },
				}),
				adminOnSomeoneElsesPersonalBot: await tried(who.admin, "bots.update", {
					botId: a.personal.id,
					changes: { name: "Mine now" },
				}),
			}).toEqual({
				creator: "ok",
				admin: "ok",
				editor: "ActionForbidden",
				viewer: "ActionForbidden",
				outsider: "ResourceHidden",
				botInChatBounds: "ActionForbidden",
				botRenamingItselfInOwnChats: "ActionForbidden",
				creatorsAssistant: "ok",
				run: "ActionForbidden",
				webhook: "ResourceHidden",
				computerSleep: "ResourceHidden",
				compaction: "ResourceHidden",
				page: "ResourceHidden",
				botWritingItsInstructionsInOwnChats: "ok",
				adminOnSomeoneElsesPersonalBot: "ResourceHidden",
			});
		});
	});

	describe("bots.remove", () => {
		it("deletes a bot for its managers and for admins restricting it, but never a Personal Assistant or a system bot", async () => {
			const refused = await outcomes(
				{
					editor: who.ed,
					viewer: who.vi,
					outsider: who.outsider,
					botOutsideItsBounds: who.pubForEd,
					runOutsideItsBounds: who.run,
					webhook: who.webhook,
					page: who.page,
				},
				async (principal) => tried(principal, "bots.remove", { botId: (await erinsBot()).id }),
			);
			const removed = await outcomes(
				{ owner: who.owner, admin: who.admin, adminsAssistant: who.adminsAssistant },
				async (principal) => tried(principal, "bots.remove", { botId: (await erinsBot()).id }),
			);
			const erinsPersonal = await seedBot(a.workspace, {
				createdById: a.erin,
				visibility: "personal",
			});

			expect({
				...refused,
				...removed,
				creatorOfPersonalBot: await tried(who.erin, "bots.remove", {
					botId: (await seedBot(a.workspace, { createdById: a.erin, visibility: "personal" })).id,
				}),
				adminOnSomeoneElsesPersonalBot: await tried(who.admin, "bots.remove", {
					botId: erinsPersonal.id,
				}),
				memberOnTheirOwnAssistant: await tried(who.ed, "bots.remove", { botId: a.assistant.id }),
				adminOnSomeoneElsesAssistant: await tried(who.admin, "bots.remove", {
					botId: a.assistant.id,
				}),
				adminOnSystemBot: await tried(who.admin, "bots.remove", { botId: a.system.id }),
				botOnItselfInChatBounds: await tried(who.pubForEd, "bots.remove", { botId: a.pub.id }),
			}).toEqual({
				editor: "ActionForbidden",
				viewer: "ActionForbidden",
				outsider: "ResourceHidden",
				botOutsideItsBounds: "ResourceHidden",
				runOutsideItsBounds: "ResourceHidden",
				webhook: "ResourceHidden",
				page: "ResourceHidden",
				owner: "ok",
				admin: "ok",
				adminsAssistant: "ok",
				creatorOfPersonalBot: "ok",
				adminOnSomeoneElsesPersonalBot: "ok",
				memberOnTheirOwnAssistant: "ActionForbidden",
				adminOnSomeoneElsesAssistant: "ResourceHidden",
				adminOnSystemBot: "ActionForbidden",
				botOnItselfInChatBounds: "ActionForbidden",
			});
		});
	});

	describe("pinning a bot", () => {
		it("pins and unpins a bot for a member signed in who can talk to it, and for a bot in member bounds only once they approve", async () => {
			for (const name of ["bots.pin", "bots.unpin"] as const) {
				expect({
					name,
					outcomes: {
						...(await outcomes(
							{
								editor: who.erin,
								viewer: who.vi,
								outsider: who.outsider,
								botInMemberBounds: who.edsAssistant,
								run: who.run,
								webhook: who.webhook,
								page: who.page,
							},
							(principal) => tried(principal, name, { botId: a.pub.id }),
						)),
						someoneElsesPersonalBot: await tried(who.erin, name, { botId: a.personal.id }),
					},
				}).toEqual({
					name,
					outcomes: {
						editor: "ok",
						viewer: "ok",
						outsider: "ResourceHidden",
						// Its member approves the call in the bot loop first.
						botInMemberBounds: "ApprovalNeeded",
						run: "ActionForbidden",
						webhook: "ResourceHidden",
						page: "ResourceHidden",
						someoneElsesPersonalBot: "ResourceHidden",
					},
				});
			}
		});
	});

	describe("bots.ensureAssistant", () => {
		it("makes a member signed in their Personal Assistant, and nobody else one", async () => {
			expect(
				await outcomes(
					{
						viewer: who.vi,
						outsider: who.outsider,
						botInChatBounds: who.pubForEd,
						botInMemberBounds: who.edsAssistant,
						run: who.run,
						webhook: who.webhook,
						page: who.page,
					},
					(principal) => tried(principal, "bots.ensureAssistant", { workspace: a.workspace }),
				),
			).toEqual({
				viewer: "ok",
				outsider: "ResourceHidden",
				botInChatBounds: "ActionForbidden",
				botInMemberBounds: "ActionForbidden",
				run: "ActionForbidden",
				webhook: "ActionForbidden",
				page: "ActionForbidden",
			});
		});
	});

	describe("systemBots.update", () => {
		it("chooses a system bot's model for the workspace's owner and admins, and a bot only in member bounds", async () => {
			expect(
				await outcomes(
					{
						owner: who.owner,
						admin: who.admin,
						editor: who.ed,
						viewer: who.vi,
						outsider: who.outsider,
						adminsBotInChatBounds: await as.botFor(a.admin, a.pub.id, a.chat),
						adminsAssistant: who.adminsAssistant,
						editorsAssistant: who.edsAssistant,
						run: who.run,
						webhook: who.webhook,
						page: who.page,
					},
					(principal) =>
						tried(principal, "systemBots.update", {
							workspace: a.workspace,
							key: "compact",
							model: OFFERED,
						}),
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
				page: "ActionForbidden",
			});
		});
	});
});
