import type { WorkspaceAutomation } from "@sugabots/contracts";
import { DEFAULT_RUN_PAGE_LIMIT } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { Data, Effect } from "effect";
import { Authorization } from "../../authorization/authorization.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { query, serviceOperations } from "../../database/database.ts";
import {
	automation,
	automationRun,
	bot,
	placedConversation,
	project,
} from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";
import { personFacingBotRow, pinnedBy, toBot } from "../../workspaces/bots/bot.ts";
import { decodeCursor, earlierThan, encodeCursor } from "../cursor.ts";
import {
	AutomationNotFound,
	automationWithTriggers,
	inScope,
	scopeOf,
	toAutomation,
	triggersOf,
} from "./automation.ts";
import type { Automations } from "./automations.ts";
import { resultPosted, toRun } from "./execution.ts";

/** What the automation screens show: the view half of `Automations.Service`. */
export const makeView = Effect.gen(function* () {
	const operation = yield* serviceOperations<ViewMethods>("Automations");
	const authorization = yield* Authorization.Service;
	const visibility = yield* Visibility.Service;

	return {
		listInWorkspace: (workspace) =>
			operation(
				"listInWorkspace",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* authorization.workspace(
						workspace,
						"workspace.read",
					);
					const reachesProject = yield* visibility.reachesProject;
					const rows = yield* query((db) =>
						db
							.select({
								automation,
								bot,
								defaultProjectId: project.id,
								pinned: pinnedBy(bot.id, actor.userId),
							})
							.from(automation)
							.innerJoin(project, eq(project.id, automation.projectId))
							// A bot's own automation, in its default project, is shown with the bot.
							.leftJoin(bot, eq(bot.id, project.defaultOfBotId))
							.where(
								and(
									eq(automation.workspaceId, workspaceId),
									isNull(automation.deletedAt),
									reachesProject(project.id),
								),
							)
							.orderBy(asc(automation.name), asc(automation.id)),
					);
					const triggers = yield* triggersOf(rows.map((row) => row.automation.id));
					return rows.map((row): WorkspaceAutomation => {
						const owner = row.bot && personFacingBotRow(row.bot);
						return {
							automation: toAutomation(row.automation, triggers.get(row.automation.id) ?? []),
							bot: owner
								? toBot(
										{ ...owner, defaultProjectId: row.defaultProjectId },
										{ actor, pinned: row.pinned },
									)
								: null,
						};
					});
				}),
			),

		list: ({ projectId }) =>
			operation(
				"list",
				Effect.gen(function* () {
					const { project: owner } = yield* authorization.project(projectId, "automation.read");
					const rows = yield* query((db) =>
						db
							.select()
							.from(automation)
							.where(
								and(
									eq(automation.workspaceId, owner.workspaceId),
									eq(automation.projectId, owner.id),
									isNull(automation.deletedAt),
								),
							)
							.orderBy(asc(automation.name)),
					);
					const triggers = yield* triggersOf(rows.map((row) => row.id));
					return rows.map((row) => toAutomation(row, triggers.get(row.id) ?? []));
				}),
			),

		get: (addressed) =>
			operation(
				"get",
				Effect.gen(function* () {
					const scope = yield* scopeOf(authorization, addressed, "automation.read");
					const [row] = yield* query((db) =>
						db.select().from(automation).where(inScope(scope)).limit(1),
					);
					if (!row) return yield* new AutomationNotFound();
					return yield* automationWithTriggers(row);
				}),
			),

		listRuns: (addressed, page = { limit: DEFAULT_RUN_PAGE_LIMIT }) =>
			operation(
				"listRuns",
				Effect.gen(function* () {
					const scope = yield* scopeOf(authorization, addressed, "automation.history.read");
					const before = page.cursor ? yield* executionCursor(page.cursor) : undefined;
					const [definition] = yield* query((db) =>
						db
							.select({ id: automation.id })
							.from(automation)
							.where(
								and(
									eq(automation.id, scope.automationId),
									eq(automation.workspaceId, scope.workspaceId),
									eq(automation.projectId, scope.projectId),
								),
							)
							.limit(1),
					);
					if (!definition) return yield* new AutomationNotFound();
					const rows = yield* query((db) =>
						db
							.select({
								run: automationRun,
								rootConversationId: placedConversation.rootConversationId,
								posted: resultPosted(automationRun.id),
							})
							.from(automationRun)
							.innerJoin(
								placedConversation,
								eq(placedConversation.id, automationRun.conversationId),
							)
							.where(
								and(
									eq(automationRun.automationId, scope.automationId),
									before
										? earlierThan(automationRun.acceptedAt, automationRun.id, before)
										: undefined,
								),
							)
							.orderBy(desc(automationRun.acceptedAt), desc(automationRun.id))
							.limit(page.limit + 1),
					);
					const items = rows.slice(0, page.limit);
					const oldest = items.at(-1)?.run;
					return {
						items: items.map(({ run, rootConversationId, posted }) => {
							if (!rootConversationId)
								throw new Error(`Automation run ${run.id} is in no conversation`);
							return toRun(run, rootConversationId, posted);
						}),
						nextCursor:
							rows.length > page.limit && oldest
								? encodeCursor({ at: oldest.acceptedAt, id: oldest.id })
								: null,
					};
				}),
			),
	} satisfies ViewMethods;
});

type ViewMethods = Pick<Automations.Interface, "listInWorkspace" | "list" | "get" | "listRuns">;

export class InvalidRunCursor extends Data.TaggedError("InvalidRunCursor") implements UserFacing {
	get userMessage() {
		return userText`That automation run cursor is invalid`;
	}
}

const executionCursor = (cursor: string) => {
	const point = decodeCursor(cursor);
	return point ? Effect.succeed(point) : Effect.fail(new InvalidRunCursor());
};
