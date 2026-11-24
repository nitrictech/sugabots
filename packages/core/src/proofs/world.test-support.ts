/**
 * A world for the prover tests: two workspaces, members of every role, bots
 * of every kind, projects and chats, and a way to get each kind of principal
 * from the authenticators, which alone build them.
 *
 * In workspace A, Ed (an editor) made the public bot Pub, which leads the
 * private project J with the bot Helper in it, and his personal bot Personal;
 * Ed, Vi (a viewer) and Quinn (an editor) are in J, and Erin (an editor) is
 * not. Ed also has a Personal Assistant. K is another project, which Ed is in
 * and Pub isn't. Ed is an admin of workspace B, which has its own project.
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

/** Each kind of principal, from its authenticator. */
export function principals(auth: Authenticators) {
	return {
		/** `memberId`, signed in. */
		member: async (memberId: string) => {
			const { token } = await seedSession(memberId);
			// A bearer token is read from its row, so no cookie is read.
			return runOnPostgres(
				auth.session
					.authenticate(new Headers({ authorization: `Bearer ${token}` }))
					.pipe(Effect.provideService(SessionAuthentication.Cookies, noCookie)),
			);
		},
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
		page: async (chatId: string) => {
			const pageId = await seedPage(chatId);
			const token = auth.secrets.encrypt(
				JSON.stringify({ fileId: pageId, version: 1, expiresAt: Date.now() + 60_000 }),
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
