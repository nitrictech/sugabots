import type { InputOf, OperationName } from "@sugabots/contracts/operations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	seedAutomation,
	seedBot,
	seedMember,
	seedProject,
	seedProjectChat,
	seedWebhookTrigger,
	unique,
} from "../../authentication/seed.test-support.ts";
import { closeDatabase } from "../../database/testing.ts";
import type { Principal } from "../../principal.ts";
import {
	authenticators,
	buildWorld,
	principals,
	type World,
} from "../../proofs/world.test-support.ts";
import { type CallOperation, servedOperations } from "../testing.ts";

/**
 * The automations operations, each called for every kind of principal
 * through the registry, as an entrypoint calls them. What each comes to is
 * "ok" or the tag of its refusal: hidden where the principal doesn't reach
 * the project, forbidden where it does but may not act. Who may do what in
 * detail is the provers' tests'; the automations' own rules are
 * `chats/automations/`'.
 *
 * The world is `buildWorld`'s: in workspace A, Ed (an editor) made the public
 * bot Pub, which leads the private project J with Helper in it, and his
 * personal bot Personal; Ed, Vi (a viewer) and Quinn are in J, and Erin (an
 * editor) isn't.
 */
describe("the automations operations, for each kind of principal", () => {
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
			/** Pub answering an admin in J's chat: chat bounds, J. */
			pubForAdmin: await as.botFor(a.admin, a.pub.id, a.chat),
			/** Helper answering Ed in K's chat: chat bounds, K, though both reach J. */
			helperInK: await as.botFor(a.ed, a.helper.id, a.otherChat),
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

	/** A new automation of `projectId`, run only by hand. */
	const anAutomation = async (projectId: string) => ({
		projectId,
		automationId: await seedAutomation(a.workspace, projectId),
	});

	describe("reading a project's automations", () => {
		it("lists them to whoever reaches the project, within a turn's bounds", async () => {
			const list = (principal: Principal) =>
				tried(principal, "automations.list", { projectId: a.project });

			expect(
				await outcomes(
					{
						admin: who.admin,
						viewer: who.vi,
						notInProject: who.erin,
						outsider: who.outsider,
						botInBounds: who.pubForEd,
						botOutsideBounds: who.helperInK,
						run: who.run,
						webhook: who.webhook,
						computerSleep: who.computerSleep,
						compaction: who.compaction,
						page: who.page,
					},
					list,
				),
			).toEqual({
				admin: "ok",
				viewer: "ok",
				notInProject: "ResourceHidden",
				outsider: "ResourceHidden",
				botInBounds: "ok",
				botOutsideBounds: "ResourceHidden",
				run: "ok",
				webhook: "ok",
				computerSleep: "ok",
				compaction: "ResourceHidden",
				page: "ResourceHidden",
			});
		});

		it("lists a project's runs to whoever reaches it", async () => {
			// A project of its own: the runs the world seeds for principals have no feed to be listed in.
			const projectId = await seedProject(a.workspace, {
				leadBotId: a.pub.id,
				members: [a.ed, a.vi],
			});
			const runs = (principal: Principal) =>
				tried(principal, "automations.projectRuns", { projectId, limit: 20 });

			expect(
				await outcomes({ admin: who.admin, viewer: who.vi, notInProject: who.erin }, runs),
			).toEqual({ admin: "ok", viewer: "ok", notInProject: "ResourceHidden" });
		});

		it("shows an admin a personal bot's automations as set up, though not their runs", async () => {
			const own = a.personal.defaultProject;
			await anAutomation(own);
			const listed = await call(who.admin, "automations.list", { projectId: own });

			expect(listed.map((automation) => "status" in automation)).toEqual([false]);
			expect({
				adminsRuns: await tried(who.admin, "automations.projectRuns", {
					projectId: own,
					limit: 20,
				}),
				editorWhoDidNotMakeIt: await tried(who.erin, "automations.list", { projectId: own }),
				creator: await tried(who.ed, "automations.list", { projectId: own }),
			}).toEqual({
				adminsRuns: "ResourceHidden",
				editorWhoDidNotMakeIt: "ResourceHidden",
				creator: "ok",
			});
		});
	});

	describe("managing a project's automations", () => {
		it("sets them up for those who manage the project, and a bot for them in its bounds", async () => {
			const create = (principal: Principal, projectId = a.project) =>
				tried(principal, "automations.create", {
					projectId,
					name: `Automation ${unique()}`,
					instructions: "Handle it.",
					triggers: [],
				});

			expect({
				...(await outcomes(
					{
						owner: who.owner,
						admin: who.admin,
						editor: who.ed,
						viewer: who.vi,
						notInProject: who.erin,
						adminsBotInChatBounds: who.pubForAdmin,
						adminsAssistant: who.adminsAssistant,
						editorsAssistant: who.edsAssistant,
						run: who.run,
						webhook: who.webhook,
						computerSleep: who.computerSleep,
						compaction: who.compaction,
						page: who.page,
					},
					(principal) => create(principal),
				)),
				creatorInBotsOwnProject: await create(who.ed, a.pub.defaultProject),
				editorInSomeoneElsesBotsProject: await create(who.erin, a.pub.defaultProject),
			}).toEqual({
				owner: "ok",
				admin: "ok",
				editor: "ActionForbidden",
				viewer: "ActionForbidden",
				notInProject: "ResourceHidden",
				adminsBotInChatBounds: "ok",
				adminsAssistant: "ok",
				editorsAssistant: "ActionForbidden",
				run: "ActionForbidden",
				webhook: "ActionForbidden",
				computerSleep: "ActionForbidden",
				compaction: "ResourceHidden",
				page: "ResourceHidden",
				creatorInBotsOwnProject: "ok",
				editorInSomeoneElsesBotsProject: "ActionForbidden",
			});
		});

		it("lets an admin only switch off a personal bot's automations, which they can't otherwise reach", async () => {
			const automation = await anAutomation(a.personal.defaultProject);

			expect({
				pausing: await tried(who.admin, "automations.update", {
					...automation,
					changes: { state: "paused" },
				}),
				renaming: await tried(who.admin, "automations.update", {
					...automation,
					changes: { name: "Mine now" },
				}),
				resuming: await tried(who.admin, "automations.update", {
					...automation,
					changes: { state: "enabled" },
				}),
				deleting: await tried(who.admin, "automations.remove", automation),
				editorWhoDidNotMakeIt: await tried(who.erin, "automations.update", {
					...automation,
					changes: { state: "paused" },
				}),
				creator: await tried(who.ed, "automations.update", {
					...automation,
					changes: { name: "Renamed" },
				}),
			}).toEqual({
				pausing: "ok",
				renaming: "ActionForbidden",
				resuming: "ActionForbidden",
				deleting: "ResourceHidden",
				editorWhoDidNotMakeIt: "ResourceHidden",
				creator: "ok",
			});
		});
	});

	describe("automations.run", () => {
		it("starts a run for anyone in the project but viewers, and for a bot for its asker in its bounds", async () => {
			const automation = await anAutomation(a.project);
			const run = (principal: Principal) =>
				tried(principal, "automations.run", { ...automation, requestId: crypto.randomUUID() });

			expect(
				await outcomes(
					{
						editor: who.ed,
						admin: who.admin,
						viewer: who.vi,
						notInProject: who.erin,
						botInBounds: who.pubForEd,
						botOutsideBounds: who.helperInK,
						run: who.run,
						webhook: who.webhook,
						computerSleep: who.computerSleep,
						page: who.page,
					},
					run,
				),
			).toEqual({
				editor: "ok",
				admin: "ok",
				viewer: "ActionForbidden",
				notInProject: "ResourceHidden",
				botInBounds: "ok",
				botOutsideBounds: "ResourceHidden",
				run: "ActionForbidden",
				webhook: "ActionForbidden",
				computerSleep: "ActionForbidden",
				page: "ResourceHidden",
			});
		});
	});

	describe("automations.webhook", () => {
		it("starts a run only for a call its own trigger's authenticator accepted", async () => {
			const own = who.webhook._tag === "WebhookCall" ? who.webhook.source : undefined;
			if (own?.kind !== "trigger") throw new Error("Expected a call to a trigger's webhook");
			const otherAutomation = await seedAutomation(a.workspace, a.project);
			const otherTrigger = await seedWebhookTrigger(
				otherAutomation,
				a.workspace,
				{ kind: "bearer" },
				null,
			);
			const webhook = (principal: Principal, triggerId: string) =>
				tried(principal, "automations.webhook", { triggerId, headers: {}, payload: {} });

			expect({
				itsOwnTrigger: await webhook(who.webhook, own.trigger),
				anotherTrigger: await webhook(who.webhook, otherTrigger),
				member: await webhook(who.admin, own.trigger),
				run: await webhook(who.run, own.trigger),
			}).toEqual({
				itsOwnTrigger: "ok",
				anotherTrigger: "WebhookRefused",
				member: "WebhookRefused",
				run: "WebhookRefused",
			});
		});
	});
});
