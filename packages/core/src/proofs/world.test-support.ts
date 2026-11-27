/**
 * A world for the prover tests: two workspaces, members of every role, bots
 * of every kind, projects and chats, and a way to get each kind of principal
 * from the authenticators, which alone build them.
 *
 * In workspace A, Ed (an editor) made the public bot Pub, which leads the
 * private project J with the bot Helper in it, and his personal bot Personal;
 * Ed, Vi (a viewer) and Quinn (an editor) are in J, and Erin (an editor) is
 * not. Ed also has a Personal Assistant, a personal bot too. K is another
 * project, which Ed is in and Pub isn't. Ed is an admin of workspace B, which has its own project.
 */

import type { RunTriggerKind } from "@sugabots/contracts";
import { Effect } from "effect";
import { PageAuthentication } from "../authentication/page.ts";
import {
	addMembership,
	type SeededBot,
	seedAutomation,
	seedBot,
	seedComputer,
	seedMember,
	seedMessage,
	seedPage,
	seedProject,
	seedProjectChat,
	seedRun,
	seedSession,
	seedTurn,
	seedTurnAnswering,
	seedWebhookTrigger,
	seedWorkspace,
} from "../authentication/seed.test-support.ts";
import { SessionAuthentication } from "../authentication/session.ts";
import { SystemWorkAuthentication } from "../authentication/system-work.ts";
import { TurnAuthentication } from "../authentication/turn.ts";
import { WebhookAuthentication } from "../authentication/webhook.ts";
import { runOnPostgres, type TestInfrastructure } from "../database/testing.ts";
import { FilePages } from "../files/pages.ts";
import type { Principal } from "../principal.ts";
import { Secrets } from "../secrets/secrets.ts";

export interface World {
	readonly a: {
		readonly workspace: string;
		readonly owner: string;
		readonly admin: string;
		readonly otherAdmin: string;
		readonly ed: string;
		readonly erin: string;
		readonly vi: string;
		readonly quinn: string;
		/** A viewer who made a public bot before becoming one. */
		readonly viewerCreator: string;
		readonly pub: SeededBot;
		readonly helper: SeededBot;
		readonly personal: SeededBot;
		readonly assistant: SeededBot;
		readonly system: SeededBot;
		readonly viewerCreatorsBot: SeededBot;
		/** J, led by Pub, with Helper; Ed, Vi and Quinn are in it. */
		readonly project: string;
		/** K, led by Helper; Ed is in it, Pub isn't. */
		readonly otherProject: string;
		/** A chat in J, started by Ed. */
		readonly chat: string;
		/** A chat in K, started by Ed. */
		readonly otherChat: string;
		/** One of Pub's own chats, started by Ed. */
		readonly pubChat: string;
		/** One of Ed's Personal Assistant's chats. */
		readonly assistantChat: string;
		/** One of Ed's personal bot Personal's chats. */
		readonly personalChat: string;
	};
	readonly b: {
		readonly workspace: string;
		readonly bot: SeededBot;
		readonly project: string;
		readonly chat: string;
	};
}

export async function buildWorld(): Promise<World> {
	const a = await seedWorkspace();
	const owner = await seedMember(a, "owner");
	const admin = await seedMember(a, "admin");
	const otherAdmin = await seedMember(a, "admin");
	const ed = await seedMember(a, "editor");
	const erin = await seedMember(a, "editor");
	const vi = await seedMember(a, "viewer");
	const quinn = await seedMember(a, "editor");
	const viewerCreator = await seedMember(a, "viewer");
	const pub = await seedBot(a, { createdById: ed });
	const helper = await seedBot(a, { createdById: erin });
	const personal = await seedBot(a, { createdById: ed, visibility: "personal" });
	const assistant = await seedBot(a, { assistantOf: ed, visibility: "personal" });
	const system = await seedBot(a, { systemBotKey: "compact" });
	const viewerCreatorsBot = await seedBot(a, { createdById: viewerCreator });
	const project = await seedProject(a, {
		leadBotId: pub.id,
		bots: [helper.id],
		members: [ed, vi, quinn],
	});
	const otherProject = await seedProject(a, { leadBotId: helper.id, members: [ed] });
	const chat = await seedProjectChat(a, project, ed);
	const otherChat = await seedProjectChat(a, otherProject, ed);
	const pubChat = await seedProjectChat(a, pub.defaultProject, ed);
	const assistantChat = await seedProjectChat(a, assistant.defaultProject, ed);
	const personalChat = await seedProjectChat(a, personal.defaultProject, ed);

	const b = await seedWorkspace();
	await addMembership(b, ed, "admin");
	const bBot = await seedBot(b, { createdById: ed });
	const bProject = await seedProject(b, { leadBotId: bBot.id, members: [ed] });
	const bChat = await seedProjectChat(b, bProject, ed);

	return {
		a: {
			workspace: a,
			owner,
			admin,
			otherAdmin,
			ed,
			erin,
			vi,
			quinn,
			viewerCreator,
			pub,
			helper,
			personal,
			assistant,
			system,
			viewerCreatorsBot,
			project,
			otherProject,
			chat,
			otherChat,
			pubChat,
			assistantChat,
			personalChat,
		},
		b: { workspace: b, bot: bBot, project: bProject, chat: bChat },
	};
}

/** The authenticators, which build every principal the tests use. */
export async function authenticators() {
	return runOnPostgres(
		Effect.all({
			session: Effect.provide(SessionAuthentication.Service, SessionAuthentication.layer),
			turn: Effect.provide(TurnAuthentication.Service, TurnAuthentication.layer),
			webhook: Effect.provide(WebhookAuthentication.Service, WebhookAuthentication.layer),
			systemWork: Effect.provide(SystemWorkAuthentication.Service, SystemWorkAuthentication.layer),
			page: Effect.provide(PageAuthentication.Service, PageAuthentication.layer),
			secrets: Effect.gen(function* () {
				return yield* Secrets.Service;
			}),
		}),
	);
}

export type Authenticators = Awaited<ReturnType<typeof authenticators>>;

/** better-auth's reading of a request that carries no session cookie. */
const noCookie: SessionAuthentication.CookiesInterface = { read: () => Effect.succeed(undefined) };

export async function signedIn(
	memberId: string,
	expiresInSeconds?: number,
	sessionAuth?: SessionAuthentication.Interface,
) {
	const sessions =
		sessionAuth ??
		(await runOnPostgres(
			Effect.provide(SessionAuthentication.Service, SessionAuthentication.layer),
		));
	const { token } = await seedSession(memberId, expiresInSeconds);
	return runOnPostgres(
		sessions
			.authenticate(new Headers({ authorization: `Bearer ${token}` }))
			.pipe(Effect.provideService(SessionAuthentication.Cookies, noCookie)),
	);
}

/** Each kind of principal, from its authenticator. */
export function principals(auth: Authenticators) {
	return {
		/** `memberId`, signed in with a session expiring `expiresInSeconds` from now. */
		member: (memberId: string, expiresInSeconds?: number) =>
			signedIn(memberId, expiresInSeconds, auth.session),
		/** `botId` answering a message `askerId` writes in `chatId`. */
		botFor: async (askerId: string, botId: string, chatId: string) => {
			const turnId = await seedTurnAnswering(chatId, botId, { member: askerId });
			const principal = await runOnPostgres(auth.turn.authenticate(turnId));
			if (principal._tag !== "BotForAsker") throw new Error("Expected a bot acting for its asker");
			return principal;
		},
		/** The principal of the turn `turnId`. */
		turn: (turnId: string) => runOnPostgres(auth.turn.authenticate(turnId)),
		/** `botId` in a new run of an automation of `projectId`, started as `startedBy` says. */
		run: async (
			workspaceId: string,
			projectId: string,
			botId: string,
			startedBy: RunTriggerKind = "routine",
		) => {
			const automationId = await seedAutomation(workspaceId, projectId);
			const run = await seedRun(workspaceId, automationId, botId, startedBy);
			const turnId = await seedTurn(run.chat, botId, run.triggerMessage, { reason: "automation" });
			return { principal: await runOnPostgres(auth.turn.authenticate(turnId)), run, turnId };
		},
		/** A call to a webhook trigger, left without a secret, of an automation of `projectId`. */
		webhook: async (workspaceId: string, projectId: string) => {
			const automationId = await seedAutomation(workspaceId, projectId);
			const triggerId = await seedWebhookTrigger(
				automationId,
				workspaceId,
				{ kind: "bearer" },
				null,
			);
			return runOnPostgres(
				auth.webhook.trigger(triggerId, { headers: {}, body: new Uint8Array(), payload: {} }),
			);
		},
		/** Compacting `chatId`, as a stored request from a reply of `botId` there asks. */
		compaction: async (chatId: string, botId: string) => {
			const reply = await seedMessage(chatId, { bot: botId });
			return runOnPostgres(auth.systemWork.compaction({ chatId, botId, sourceMessageId: reply }));
		},
		/** Putting the computer of `projectId` to sleep. */
		computerSleep: async (workspaceId: string, projectId: string) => {
			const computerId = await seedComputer(workspaceId, projectId);
			return {
				principal: await runOnPostgres(auth.systemWork.computerSleep(computerId)),
				computerId,
			};
		},
		/** Whoever holds the address of a page in `chatId`. */
		page: async (chatId: string, memberId: string) => {
			const pageId = await seedPage(chatId);
			const token = auth.secrets.encrypt(
				JSON.stringify({ fileId: pageId, memberId, version: 1, expiresAt: Date.now() + 60_000 }),
				FilePages.SECRET_PURPOSE,
			);
			return runOnPostgres(auth.page.open(token));
		},
	};
}

/**
 * What `effect` came to: `"ok"`, or the tag of the error it failed with, so a
 * case can lay out who gets what as a table.
 */
export const outcome = <A, E extends { readonly _tag: string }>(
	effect: Effect.Effect<A, E, TestInfrastructure>,
): Promise<"ok" | E["_tag"]> =>
	runOnPostgres(
		effect.pipe(
			Effect.as("ok" as const),
			Effect.catch((failure: E) => Effect.succeed(failure._tag)),
		),
	);

export async function everyKindOfPrincipal(world: World, as: ReturnType<typeof principals>) {
	const { a, b } = world;
	const outsider = await seedMember(b.workspace, "editor");
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
		erin: await as.member(a.erin),
		vi: await as.member(a.vi),
		quinn: await as.member(a.quinn),
		outsider: await as.member(outsider),
		pubForEd: await as.botFor(a.ed, a.pub.id, a.chat),
		pubForAdmin: await as.botFor(a.admin, a.pub.id, a.chat),
		pubInOwnChats: await as.botFor(a.ed, a.pub.id, a.pubChat),
		helperInK: await as.botFor(a.ed, a.helper.id, a.otherChat),
		edsAssistant: await as.botFor(a.ed, a.assistant.id, a.assistantChat),
		adminsAssistant: await as.botFor(a.admin, adminsAssistant.id, adminsAssistantChat),
		run: (await as.run(a.workspace, a.project, a.pub.id)).principal,
		webhook: await as.webhook(a.workspace, a.project),
		computerSleep: (await as.computerSleep(a.workspace, a.project)).principal,
		compaction: await as.compaction(a.chat, a.pub.id),
		page: await as.page(a.chat, a.ed),
	};
}

export async function outcomesFor<Key extends string, Result>(
	principals: Record<Key, Principal>,
	attempt: (principal: Principal) => Promise<Result>,
): Promise<Record<Key, Result>> {
	const entries = await Promise.all(
		Object.entries<Principal>(principals).map(async ([key, principal]) => [
			key,
			await attempt(principal),
		]),
	);
	return Object.fromEntries(entries) as Record<Key, Result>;
}
