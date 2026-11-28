export {
	BotNotPublic,
	PersonalBotInProject,
	ProjectGone,
	ProjectHasPrivateBots,
	ProjectSlugTaken,
} from "@sugabots/contracts/errors/projects";
export * as ProjectStore from "./project-store.ts";

import {
	administersWorkspace,
	leastUsedProjectColor,
	type ProjectColor,
	type ProjectUpdate,
	type ProjectVisibility,
} from "@sugabots/contracts";
import {
	type BotNotPublic,
	type PersonalBotInProject,
	ProjectGone,
	ProjectHasPrivateBots,
	ProjectSlugTaken,
} from "@sugabots/contracts/errors/projects";
import { DisplayName } from "@sugabots/errors";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { query, queryCatching, serviceOperations, transaction } from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import type * as schema from "../../database/schema.ts";
import { bot, membership, project, projectBot, projectMember } from "../../database/schema.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { checkProjectBotVisibility, projectColorOf } from "./project.ts";
import { type LeadsProjects, refuseWhileLeading } from "./project-leads.ts";

/**
 * The only writer of `project`, `project_member` and `project_bot`: projects, the members
 * in them, and their bots. A bot's default project is the exception, made
 * with its bot by a trigger (see `project`).
 *
 * A project's own rules are enforced here, so they hold however it is
 * reached: its slug is unique in its workspace, no personal bot is in one, a
 * private bot only in a private one, and its lead bot is one of its bots. Whether somebody may ask for any of this is
 * not decided here. `update` refuses a default project as gone, before it
 * writes anything; `remove` and the member and bot methods don't check, so their callers pass a project
 * members made, which they have already authorized.
 */
export interface Interface {
	/**
	 * Creates a project with `creatorId` as its first member, led by the bot
	 * `leadBotId`, which is its first bot, on the terms of {@link Interface.addBot}.
	 * Without a colour it takes the one fewest of the workspace's projects have.
	 */
	readonly create: (
		workspaceId: string,
		input: {
			creatorId: string;
			name: string;
			slug: string;
			color?: ProjectColor;
			description?: string | null;
			visibility?: ProjectVisibility;
			leadBotId: string;
		},
	) => Effect.Effect<schema.ProjectRow, ProjectSlugTaken | BotNotPublic | PersonalBotInProject>;
	/**
	 * Changes a project members made; a new lead bot is added to its bots, on
	 * the terms of {@link Interface.addBot} for the project as changed. Made
	 * public, it is refused while it has private bots. A default project, or
	 * one not in `workspaceId`, fails with `ProjectGone` before anything is written.
	 */
	readonly update: (
		workspaceId: string,
		projectId: string,
		changes: ProjectUpdate,
	) => Effect.Effect<
		schema.ProjectRow,
		ProjectGone | ProjectSlugTaken | BotNotPublic | PersonalBotInProject | ProjectHasPrivateBots
	>;
	/** Removes a project. One already gone counts as removed. */
	readonly markDeleting: (workspaceId: string, projectId: string) => Effect.Effect<boolean>;
	readonly remove: (workspaceId: string, projectId: string) => Effect.Effect<void>;
	/**
	 * Adds a member in the project's workspace, and says whether `memberId` is in
	 * the project now: `false` when they aren't in its workspace. Adding
	 * somebody already in it changes nothing.
	 */
	readonly addMember: (
		workspaceId: string,
		projectId: string,
		memberId: string,
	) => Effect.Effect<boolean>;
	/**
	 * Puts `memberId` in the public project members made, checking its visibility
	 * under the project's lock, so the join can't follow a change making it
	 * private. Returns the project as it then is, with `memberId` in it, or
	 * undefined when it is private, a bot's default project or gone, or
	 * `memberId` is not in its workspace. Somebody already in it stays in it.
	 */
	readonly join: (
		workspaceId: string,
		projectId: string,
		memberId: string,
	) => Effect.Effect<schema.ProjectRow | undefined>;
	/** Refuses an administrator, who belongs to every project members made. */
	readonly removeMember: (
		workspaceId: string,
		projectId: string,
		memberId: string,
	) => Effect.Effect<"removed" | "not_a_member" | "administrator">;
	readonly checkBotAddition: (
		workspaceId: string,
		projectId: string,
		botId: string,
	) => Effect.Effect<void, BotNotPublic | PersonalBotInProject>;
	/**
	 * Puts a bot of the workspace in the project: a public bot in any, a
	 * private bot in a private one, and a personal bot in none. Adding one
	 * already in it changes nothing.
	 */
	readonly addBot: (
		workspaceId: string,
		projectId: string,
		botId: string,
	) => Effect.Effect<void, BotNotPublic | PersonalBotInProject>;
	/**
	 * Takes the bot out of every public project members made, as it is made
	 * private, and returns those projects' ids. The caller first refuses while
	 * it leads one.
	 */
	readonly removeBotFromPublicProjects: (
		workspaceId: string,
		botId: string,
	) => Effect.Effect<string[]>;
	/**
	 * Refused for the project's lead bot, which stays until another is chosen;
	 * the refusal is worded for `viewerId`.
	 */
	readonly removeBot: (
		workspaceId: string,
		projectId: string,
		botId: string,
		viewerId: string,
	) => Effect.Effect<void, LeadsProjects>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/ProjectStore") {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ProjectStore");

	const checkBotAddition = (
		workspaceId: string,
		projectId: string,
		botId: string,
		lockRows = false,
	) =>
		Effect.gen(function* () {
			const [pair] = yield* query((db) => {
				const pair = db
					.select({ botVisibility: bot.visibility, projectVisibility: project.visibility })
					.from(project)
					.innerJoin(bot, eq(bot.workspaceId, project.workspaceId))
					.where(
						and(
							eq(project.id, projectId),
							eq(project.workspaceId, workspaceId),
							eq(bot.id, botId),
							isNull(bot.systemBotKey),
						),
					);
				return lockRows ? pair.for("share", { of: [bot, project] }) : pair;
			});
			yield* checkProjectBotVisibility(pair?.botVisibility, pair?.projectVisibility);
		});

	const addBot = (workspaceId: string, projectId: string, botId: string) =>
		Effect.gen(function* () {
			// Hold both rows so a visibility change cannot miss the new bot or project membership.
			yield* checkBotAddition(workspaceId, projectId, botId, true);
			yield* query((db) =>
				db.insert(projectBot).values({ workspaceId, projectId, botId }).onConflictDoNothing(),
			);
		});

	/** Refuses to leave the project public while any of its bots is private, naming them. */
	const refuseWhilePrivateBots = (projectId: string) =>
		Effect.gen(function* () {
			const privateBots = yield* query((db) =>
				db
					.select({ name: bot.name })
					.from(projectBot)
					.innerJoin(bot, eq(bot.id, projectBot.botId))
					.where(and(eq(projectBot.projectId, projectId), eq(bot.visibility, "private")))
					.orderBy(asc(bot.name)),
			);
			if (privateBots.length === 0) return;
			return yield* new ProjectHasPrivateBots({
				bots: privateBots.map((one) => DisplayName.fromRecord(one.name)),
			});
		});

	/**
	 * Puts `memberId` in the project if they are in its workspace, and says
	 * whether this added them. Somebody already in it is left as they are.
	 */
	const insertMember = (workspaceId: string, projectId: string, memberId: string) =>
		query((db) =>
			db.execute<{ id: string }>(
				sql`
				insert into ${projectMember} ("workspace_id", "project_id", "member_id")
				select ${project.workspaceId}, ${project.id}, ${memberId}
				from ${project}
				inner join ${membership}
					on ${membership.workspaceId} = ${project.workspaceId}
					and ${membership.memberId} = ${memberId}
					and not ${membership.leaving}
				where ${project.id} = ${projectId}
				and ${project.workspaceId} = ${workspaceId}
				on conflict ("project_id", "member_id") do nothing
				returning "id"
			`,
				"objects",
			),
		).pipe(Effect.map((inserted) => inserted.length > 0));

	/**
	 * Adds a member in the project's workspace, as {@link insertMember} does,
	 * and says whether `memberId` is in the project now: added, or already in it,
	 * as when another request added them at the same time.
	 */
	const addedOrAlreadyMember = (workspaceId: string, projectId: string, memberId: string) =>
		Effect.gen(function* () {
			if (yield* insertMember(workspaceId, projectId, memberId)) return true;
			// `project_member`'s foreign key to `membership` means somebody
			// already in the project is in its workspace.
			const [existing] = yield* query((db) =>
				db
					.select({ id: projectMember.id })
					.from(projectMember)
					.where(
						and(
							eq(projectMember.workspaceId, workspaceId),
							eq(projectMember.projectId, projectId),
							eq(projectMember.memberId, memberId),
						),
					)
					.limit(1),
			);
			return existing !== undefined;
		});

	return Service.of({
		create: (workspaceId, { creatorId, name, slug, color, description, visibility, leadBotId }) =>
			operation(
				"create",
				// One unit, so a project is never briefly without its members: whoever
				// made it, and every administrator.
				transaction(
					Effect.gen(function* () {
						const taken = yield* query((db) =>
							db
								.select({ color: project.color })
								.from(project)
								.where(and(eq(project.workspaceId, workspaceId), isNull(project.defaultOfBotId))),
						);
						const [row] = yield* query((db) =>
							db
								.insert(project)
								.values({
									workspaceId,
									name,
									slug,
									color:
										color ?? leastUsedProjectColor(taken.map((one) => projectColorOf(one.color))),
									description: description ?? null,
									visibility: visibility ?? "public",
									createdById: creatorId,
									leadBotId,
								})
								.onConflictDoNothing({
									target: [project.workspaceId, project.slug],
									where: isNull(project.defaultOfBotId),
								})
								.returning(),
						);
						if (!row) {
							return yield* new ProjectSlugTaken({ slug });
						}
						// The `project_administrators` trigger has already added every
						// administrator, the creator too if they are one.
						yield* query((db) =>
							db
								.insert(projectMember)
								.values({ workspaceId, projectId: row.id, memberId: creatorId })
								.onConflictDoNothing({ target: [projectMember.projectId, projectMember.memberId] }),
						);
						yield* addBot(workspaceId, row.id, leadBotId);
						return row;
					}),
				),
			),

		update: (workspaceId, projectId, changes) =>
			operation(
				"update",
				transaction(
					Effect.gen(function* () {
						// Checked before anything is written, so a default project, or one
						// gone, is refused without its lead being added to its bots. Locked,
						// as `removeBot` locks it, so a bot is not taken out of the project
						// between being found among its bots here and being made its lead.
						const membersMade = and(
							eq(project.id, projectId),
							eq(project.workspaceId, workspaceId),
							isNull(project.defaultOfBotId),
						);
						const [found] = yield* query((db) =>
							db.select({ id: project.id }).from(project).where(membersMade).limit(1).for("update"),
						);
						if (!found) {
							return yield* new ProjectGone({ projectId });
						}
						// An UPDATE has no `on conflict`, so a taken slug arrives as a unique
						// violation. The slug is the only unique column a change can touch.
						const [row] = yield* queryCatching(
							(db) => db.update(project).set(changes).where(membersMade).returning(),
							(failure) =>
								isUniqueViolation(failure) && changes.slug !== undefined
									? new ProjectSlugTaken({ slug: changes.slug })
									: undefined,
						);
						if (!row) {
							return yield* new ProjectGone({ projectId });
						}
						// After the update, so a new lead is checked against the visibility
						// it is changed to; a refusal rolls the update back.
						if (changes.leadBotId !== undefined) {
							yield* addBot(workspaceId, projectId, changes.leadBotId);
						}
						if (row.visibility === "public") yield* refuseWhilePrivateBots(projectId);
						return row;
					}),
				),
			),

		markDeleting: (workspaceId, projectId) =>
			operation(
				"markDeleting",
				query((db) =>
					db
						.update(project)
						.set({ deleting: true })
						.where(
							and(
								eq(project.id, projectId),
								eq(project.workspaceId, workspaceId),
								eq(project.deleting, false),
							),
						)
						.returning({ id: project.id }),
				).pipe(Effect.map(([started]) => started !== undefined)),
			),

		remove: (workspaceId, projectId) =>
			operation(
				"remove",
				query((db) =>
					db
						.delete(project)
						.where(and(eq(project.id, projectId), eq(project.workspaceId, workspaceId))),
				).pipe(Effect.asVoid),
			),

		addMember: (workspaceId, projectId, memberId) =>
			operation("addMember", addedOrAlreadyMember(workspaceId, projectId, memberId)),

		join: (workspaceId, projectId, memberId) =>
			operation(
				"join",
				transaction(
					Effect.gen(function* () {
						// Shared, so a change of visibility waits for the join, and the
						// join for it.
						const [found] = yield* query((db) =>
							db
								.select()
								.from(project)
								.where(and(eq(project.id, projectId), eq(project.workspaceId, workspaceId)))
								.limit(1)
								.for("share"),
						);
						if (!found) return undefined;
						const [already] = yield* query((db) =>
							db
								.select({ id: projectMember.id })
								.from(projectMember)
								.where(
									and(eq(projectMember.projectId, projectId), eq(projectMember.memberId, memberId)),
								)
								.limit(1),
						);
						if (already) return found;
						if (found.visibility !== "public" || found.defaultOfBotId !== null) return undefined;
						return (yield* addedOrAlreadyMember(workspaceId, projectId, memberId))
							? found
							: undefined;
					}),
				),
			),

		removeMember: (workspaceId, projectId, memberId) =>
			operation(
				"removeMember",
				transaction(
					Effect.gen(function* () {
						// Held until the transaction ends, so nobody is promoted between the
						// role check and the delete. The project and role triggers take it too.
						yield* query((db) => db.execute(sql`select lock_project_membership(${workspaceId})`));
						const [held] = yield* query((db) =>
							db
								.select({ role: membership.role })
								.from(membership)
								.where(
									and(
										eq(membership.workspaceId, workspaceId),
										eq(membership.memberId, memberId),
										eq(membership.leaving, false),
									),
								)
								.limit(1),
						);
						if (administersWorkspace(held?.role)) {
							return "administrator";
						}
						const removed = yield* query((db) =>
							db
								.delete(projectMember)
								.where(
									and(
										eq(projectMember.workspaceId, workspaceId),
										eq(projectMember.projectId, projectId),
										eq(projectMember.memberId, memberId),
									),
								)
								.returning({ id: projectMember.id }),
						);
						return removed.length > 0 ? "removed" : "not_a_member";
					}),
				),
			),

		checkBotAddition: (workspaceId, projectId, botId) =>
			operation("checkBotAddition", checkBotAddition(workspaceId, projectId, botId)),

		addBot: (workspaceId, projectId, botId) =>
			operation("addBot", transaction(addBot(workspaceId, projectId, botId))),

		removeBotFromPublicProjects: (workspaceId, botId) =>
			operation(
				"removeBotFromPublicProjects",
				query((db) =>
					db.execute<{ project_id: string }>(
						sql`
						delete from ${projectBot}
						using ${project}
						where ${projectBot.workspaceId} = ${workspaceId}
							and ${projectBot.botId} = ${botId}
							and ${project.id} = ${projectBot.projectId}
							and ${project.defaultOfBotId} is null
							and ${project.visibility} = 'public'
						returning ${projectBot.projectId}
					`,
						"objects",
					),
				).pipe(Effect.map((left) => left.map((one) => one.project_id))),
			),

		removeBot: (workspaceId, projectId, botId, viewerId) =>
			operation(
				"removeBot",
				transaction(
					Effect.gen(function* () {
						// Locked first, so a lead chosen meanwhile is seen below.
						yield* query((db) =>
							db
								.select({ id: project.id })
								.from(project)
								.where(and(eq(project.id, projectId), eq(project.workspaceId, workspaceId)))
								.for("update"),
						);
						yield* refuseWhileLeading(botId, { viewerId, projectId });
						yield* query((db) =>
							db
								.delete(projectBot)
								.where(
									and(
										eq(projectBot.workspaceId, workspaceId),
										eq(projectBot.projectId, projectId),
										eq(projectBot.botId, botId),
									),
								),
						);
					}),
				),
			),
	});
});

export const layer = processLayer(Layer.effect(Service, make));
