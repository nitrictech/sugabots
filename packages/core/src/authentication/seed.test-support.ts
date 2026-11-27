import {
	addTestMemberships,
	createTestMember,
	createTestWorkspace,
} from "../database/workspace.test-support.ts";
/**
 * Rows for the authenticator and prover tests, written straight into the
 * test database: a workspace, its members by role, bots of each kind,
 * projects with their members and bots, chats, messages, turns, automations
 * and their runs. Every name and handle is unique, so cases in one file never
 * collide, and each case can put matching rows in two workspaces.
 */

import { randomUUID } from "node:crypto";
import type { ConnectorTool, RunTriggerKind, WorkspaceRole } from "@sugabots/contracts";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import type { Computers } from "../computers/computers.ts";
import { query, transaction } from "../database/database.ts";
import {
	automation,
	automationRun,
	automationTrigger,
	bot,
	botMember,
	chat,
	computer,
	computerProvider,
	connector,
	file,
	invitation,
	membership,
	message,
	project,
	projectBot,
	projectBotConnector,
	projectChat,
	projectMember,
	session,
	type ToolAccess,
	type TurnReason,
	type TurnStatus,
	turn,
} from "../database/schema.ts";
import { onDatabase, runOnPostgres } from "../database/testing.ts";
import { askerColumns } from "./turn-facts.ts";

/** A suffix no other fixture in this run has. */
export const unique = () => randomUUID().slice(0, 8);

/** The one row a fixture insert returned. */
function only<Row>(rows: readonly Row[]): Row {
	const [row] = rows;
	if (!row) throw new Error("A fixture insert returned no row");
	return row;
}

export async function seedWorkspace(): Promise<string> {
	return (await createTestWorkspace()).id;
}

/** A new member with `role` in `workspaceId`. */
export async function seedMember(
	workspaceId: string,
	role: WorkspaceRole,
	fields: { readonly email?: string; readonly emailVerified?: boolean } = {},
): Promise<string> {
	const suffix = unique();
	const created = await createTestMember(
		{
			name: `Member ${suffix}`,
			email: fields.email ?? `member-${suffix}@example.com`,
			emailVerified: fields.emailVerified ?? true,
		},
		{ workspaceId, role },
	);
	return created.id;
}

export async function addMembership(workspaceId: string, memberId: string, role: WorkspaceRole) {
	await addTestMemberships({ workspaceId, memberId, role });
}

export async function setRole(workspaceId: string, memberId: string, role: WorkspaceRole) {
	await onDatabase((db) =>
		db
			.update(membership)
			.set({ role })
			.where(and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, memberId))),
	);
}

export interface SeededBot {
	readonly id: string;
	/** Its hidden default project, which the database makes with it; none for a system bot. */
	readonly defaultProject: string;
}

/** A bot, public unless said otherwise, with its default project. */
export async function seedBot(
	workspaceId: string,
	fields: {
		readonly createdById?: string | null;
		readonly visibility?: "public" | "private" | "personal";
		/** A private bot's members besides the owner and admins, whom the database adds. */
		readonly members?: readonly string[];
		readonly assistantOf?: string;
		readonly systemBotKey?: "compact";
		readonly usesComputer?: boolean;
	} = {},
): Promise<SeededBot> {
	const suffix = unique();
	const row = only(
		await onDatabase((db) =>
			db
				.insert(bot)
				.values({
					workspaceId,
					name: `Bot ${suffix}`,
					handle: `bot-${suffix}`,
					color: "green",
					eyes: "pill",
					visibility: fields.visibility ?? "public",
					// A Personal Assistant's creator is the member it is for.
					createdById: fields.createdById ?? fields.assistantOf ?? null,
					assistantOf: fields.assistantOf ?? null,
					systemBotKey: fields.systemBotKey ?? null,
					usesComputer: fields.usesComputer ?? false,
				})
				.returning({ id: bot.id }),
		),
	);
	const members = fields.members ?? [];
	if (members.length > 0) {
		await onDatabase((db) =>
			db
				.insert(botMember)
				.values(members.map((memberId) => ({ workspaceId, botId: row.id, memberId })))
				.onConflictDoNothing(),
		);
	}
	const [owned] = await onDatabase((db) =>
		db.select({ id: project.id }).from(project).where(eq(project.defaultOfBotId, row.id)),
	);
	return { id: row.id, defaultProject: owned?.id ?? "" };
}

/**
 * A project members made, led by `leadBotId`, with `members` in it besides the
 * owner and admins, whom the database puts in every one, and `bots` besides
 * its lead.
 */
export async function seedProject(
	workspaceId: string,
	fields: {
		readonly leadBotId: string;
		readonly members?: readonly string[];
		readonly bots?: readonly string[];
		readonly visibility?: "public" | "private";
	},
): Promise<string> {
	const suffix = unique();
	const row = only(
		await onDatabase((db) =>
			db
				.insert(project)
				.values({
					workspaceId,
					name: `Project ${suffix}`,
					slug: `project-${suffix}`,
					visibility: fields.visibility ?? "private",
					leadBotId: fields.leadBotId,
				})
				.returning({ id: project.id }),
		),
	);
	const members = fields.members ?? [];
	if (members.length > 0) {
		await onDatabase((db) =>
			db
				.insert(projectMember)
				.values(members.map((memberId) => ({ workspaceId, projectId: row.id, memberId })))
				.onConflictDoNothing(),
		);
	}
	await onDatabase((db) =>
		db
			.insert(projectBot)
			.values(
				[fields.leadBotId, ...(fields.bots ?? [])].map((botId) => ({
					workspaceId,
					projectId: row.id,
					botId,
				})),
			)
			.onConflictDoNothing(),
	);
	return row.id;
}

/** A chat in `projectId`, a bot's default project included, started by `startedById`. */
export async function seedProjectChat(
	workspaceId: string,
	projectId: string,
	startedById: string,
): Promise<string> {
	const id = randomUUID();
	await runOnPostgres(
		transaction(
			Effect.gen(function* () {
				yield* query((db) =>
					db.insert(chat).values({ id, workspaceId, kind: "project_chat", title: "Chat" }),
				);
				yield* query((db) =>
					db.insert(projectChat).values({ chatId: id, workspaceId, projectId, startedById }),
				);
			}),
		),
	);
	return id;
}

/** Who wrote a fixture message: a member, a bot (in one of its turns, or none), or an automation's trigger. */
export type Author =
	| { readonly member: string }
	| { readonly bot: string; readonly turn?: string }
	| { readonly run: string; readonly triggerKind: RunTriggerKind };

export async function seedMessage(chatId: string, author: Author): Promise<string> {
	const row = only(
		await onDatabase((db) =>
			db
				.insert(message)
				.values({
					chatId,
					status: "complete",
					parts: [],
					content: "Hello",
					...("member" in author && { authorMemberId: author.member }),
					...("bot" in author && { authorBotId: author.bot, turnId: author.turn ?? null }),
					...("run" in author && {
						automationTrigger: {
							kind: "automation_trigger" as const,
							runId: author.run,
							automationName: "Automation",
							triggerKind: author.triggerKind,
						},
					}),
				})
				.returning({ id: message.id }),
		),
	);
	return row.id;
}

export async function seedTurn(
	chatId: string,
	botId: string,
	triggerMessageId: string,
	fields: { readonly reason?: TurnReason; readonly status?: TurnStatus } = {},
): Promise<string> {
	const status = fields.status ?? "running";
	const ended = status !== "running" && status !== "waiting";
	const row = only(
		await onDatabase((db) =>
			db
				.insert(turn)
				.values({
					chatId,
					botId,
					triggerMessageId,
					status,
					model: "test/model",
					reason: fields.reason ?? "mention",
					startedAt: new Date(),
					...(ended && { finishedAt: new Date() }),
					...(status === "failed" && { error: "It failed" as never }),
					...askerColumns({ chatId: chatId, botId: botId, triggerMessageId: triggerMessageId }),
				})
				.returning({ id: turn.id }),
		),
	);
	return row.id;
}

/** A turn of `botId` answering a new message `author` wrote in `chatId`. */
export async function seedTurnAnswering(
	chatId: string,
	botId: string,
	author: Author,
	fields: { readonly reason?: TurnReason; readonly status?: TurnStatus } = {},
): Promise<string> {
	return seedTurn(chatId, botId, await seedMessage(chatId, author), fields);
}

export async function seedAutomation(
	workspaceId: string,
	projectId: string,
	fields: { readonly state?: "enabled" | "paused"; readonly deleted?: boolean } = {},
): Promise<string> {
	const row = only(
		await onDatabase((db) =>
			db
				.insert(automation)
				.values({
					workspaceId,
					projectId,
					name: `Automation ${unique()}`,
					instructions: "Do the thing",
					state: fields.state ?? "enabled",
					...(fields.deleted && { deletedAt: new Date() }),
				})
				.returning({ id: automation.id }),
		),
	);
	return row.id;
}

/** A routine of `automationId`, due `dueInSeconds` from now: negative when it is already due. */
export async function seedRoutine(automationId: string, workspaceId: string, dueInSeconds: number) {
	const row = only(
		await onDatabase((db) =>
			db
				.insert(automationTrigger)
				.values({
					workspaceId,
					automationId,
					settings: {
						kind: "routine",
						schedule: { repeat: "cron", expression: "0 9 * * *" },
						timezone: "UTC",
					},
					nextScheduledAt: new Date(Date.now() + dueInSeconds * 1000),
				})
				.returning({ id: automationTrigger.id }),
		),
	);
	return row.id;
}

/** A webhook trigger of `automationId`, checking callers with `auth` and the encrypted `secret`. */
export async function seedWebhookTrigger(
	automationId: string,
	workspaceId: string,
	auth: { readonly kind: "bearer" } | { readonly kind: "github" },
	secret: string | null,
) {
	const row = only(
		await onDatabase((db) =>
			db
				.insert(automationTrigger)
				.values({
					workspaceId,
					automationId,
					settings: { kind: "webhook", auth, deliveryIdHeader: null },
					secretEncrypted: secret,
				})
				.returning({ id: automationTrigger.id }),
		),
	);
	return row.id;
}

export interface SeededRun {
	readonly run: string;
	readonly chat: string;
	/** The message its automation's trigger posted, which its first turn answers. */
	readonly triggerMessage: string;
}

/** A run of `automationId` by `botId`, started as `startedBy` says, in a chat of its own. */
export async function seedRun(
	workspaceId: string,
	automationId: string,
	botId: string,
	startedBy: RunTriggerKind,
	fields: { readonly state?: "queued" | "completed" | "failed"; readonly acceptedAt?: Date } = {},
): Promise<SeededRun> {
	const run = randomUUID();
	const chatId = randomUUID();
	const now = new Date().toISOString();
	const trigger = (() => {
		switch (startedBy) {
			case "routine":
				return { kind: "routine" as const, scheduledAt: now, acceptedAt: now };
			case "webhook":
				return { kind: "webhook" as const, receivedAt: now, idempotencyKey: null, payload: {} };
			case "manual":
				return {
					kind: "manual" as const,
					requestedAt: now,
					requestedByMemberId: randomUUID(),
					requestId: randomUUID(),
				};
			case "github":
				return {
					kind: "github" as const,
					connectorId: randomUUID(),
					receivedAt: now,
					deliveryId: randomUUID(),
					event: "push" as never,
					repository: "owner/repository",
					sender: "someone",
					url: "https://github.com/owner/repository",
					number: null,
					title: null,
					text: null,
					branch: null,
				};
		}
	})();
	const state = fields.state ?? "queued";
	await runOnPostgres(
		transaction(
			Effect.gen(function* () {
				yield* query((db) =>
					db.insert(chat).values({ id: chatId, workspaceId, kind: "run", title: "Run" }),
				);
				yield* query((db) =>
					db.insert(automationRun).values({
						id: run,
						automationId,
						workspaceId,
						botId,
						chatId,
						triggerKind: startedBy,
						triggerIdentity: startedBy === "webhook" ? null : randomUUID(),
						trigger,
						automationName: "Automation",
						instructions: "Do the thing",
						state,
						...(fields.acceptedAt && { acceptedAt: fields.acceptedAt }),
						...(state !== "queued" && { startedAt: new Date(), finishedAt: new Date() }),
					}),
				);
			}),
		),
	);
	const triggerMessage = await seedMessage(chatId, { run, triggerKind: startedBy });
	return { run, chat: chatId, triggerMessage };
}

/** A connector of `projectId` with `tools`, of which `toolAccess` says what bots may do. */
export async function seedConnector(
	workspaceId: string,
	projectId: string,
	fields: {
		readonly tools?: readonly ConnectorTool[];
		readonly toolAccess?: ToolAccess;
		readonly github?: { readonly appCredentialEncrypted: string };
	} = {},
): Promise<string> {
	const suffix = unique();
	const row = only(
		await onDatabase((db) =>
			db
				.insert(connector)
				.values({
					workspaceId,
					projectId,
					name: `Connector ${suffix}`,
					handle: `connector_${suffix}`,
					url: "https://connector.example.com",
					tools: [...(fields.tools ?? [])],
					toolAccess: fields.toolAccess ?? {},
					...(fields.github && {
						kind: "github" as const,
						settings: {
							kind: "github" as const,
							appId: 1,
							slug: `app-${suffix}`,
							owner: { login: "owner", type: "Organization" as const },
							installationId: null,
							account: null,
							repositories: [],
						},
						appCredentialEncrypted: fields.github.appCredentialEncrypted,
					}),
				})
				.returning({ id: connector.id }),
		),
	);
	return row.id;
}

/**
 * Turns the bot `botId`'s own connector `connectorId` on in the project
 * `projectId`, which the bot is in, for the address the connector has now.
 */
export async function seedProjectBotConnector(
	workspaceId: string,
	projectId: string,
	botId: string,
	connectorId: string,
): Promise<void> {
	const found = only(
		await onDatabase((db) =>
			db
				.select({ addressRevision: connector.addressRevision })
				.from(connector)
				.where(eq(connector.id, connectorId)),
		),
	);
	await onDatabase((db) =>
		db.insert(projectBotConnector).values({
			workspaceId,
			projectId,
			botId,
			connectorId,
			addressRevision: found.addressRevision,
		}),
	);
}

/** The online computer of `projectId`, at a computer provider of its own. */
export async function seedComputer(workspaceId: string, projectId: string): Promise<string> {
	const provider = only(
		await onDatabase((db) =>
			db
				.insert(computerProvider)
				.values({
					workspaceId,
					settings: { builtIn: "opensandbox", serverUrl: "http://computers.test", image: "debian" },
				})
				.returning({ id: computerProvider.id }),
		),
	);
	const row = only(
		await onDatabase((db) =>
			db
				.insert(computer)
				.values({
					workspaceId,
					projectId,
					computerProviderId: provider.id,
					providerComputerId: `computer-${projectId}` as Computers.ComputerId,
					image: "debian",
				})
				.returning({ id: computer.id }),
		),
	);
	return row.id;
}

/** A bot-made HTML page in `chatId`, with `versions` versions. */
export async function seedPage(chatId: string, versions = 1): Promise<string> {
	const row = only(
		await onDatabase((db) =>
			db
				.insert(file)
				.values({ chatId, kind: "html", name: "Page", currentVersion: versions })
				.returning({ id: file.id }),
		),
	);
	return row.id;
}

/** A session of `memberId`, expiring `expiresInSeconds` from now. */
export async function seedSession(memberId: string, expiresInSeconds = 3600) {
	const token = `token-${randomUUID()}`;
	const row = only(
		await onDatabase((db) =>
			db
				.insert(session)
				.values({ memberId, token, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) })
				.returning({ id: session.id }),
		),
	);
	return { id: row.id, token };
}

/** An invitation to `workspaceId` for `email`, with `role`. */
export async function seedInvitation(
	workspaceId: string,
	inviterId: string,
	fields: {
		readonly email: string;
		readonly role?: "admin" | "editor" | "viewer";
		readonly status?: "pending" | "accepted" | "canceled";
		readonly expiresInSeconds?: number;
	},
): Promise<string> {
	const row = only(
		await onDatabase((db) =>
			db
				.insert(invitation)
				.values({
					workspaceId,
					inviterId,
					email: fields.email.toLowerCase(),
					role: fields.role ?? "editor",
					status: fields.status ?? "pending",
					expiresAt: new Date(Date.now() + (fields.expiresInSeconds ?? 3600) * 1000),
				})
				.returning({ id: invitation.id }),
		),
	);
	return row.id;
}
