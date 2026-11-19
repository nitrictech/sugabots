import {
	DEFAULT_RUN_PAGE_LIMIT,
	type ListedAutomationDefinition,
	type RunPageQuery,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, asc, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import { Authorization } from "../../authorization/authorization.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { type Executor, query, serviceOperations } from "../../database/database.ts";
import { automation, automationRun, placedConversation } from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";
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
import { latestRunOf, listStatusColumns, resultPosted, toListStatus, toRun } from "./execution.ts";

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
					const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
					const reachesProject = yield* visibility.reachesProject;
					const rows = yield* query((db) =>
						db
							.select()
							.from(automation)
							.where(
								and(
									eq(automation.workspaceId, workspaceId),
									isNull(automation.deletedAt),
									reachesProject(automation.projectId),
								),
							)
							.orderBy(asc(automation.name), asc(automation.id)),
					);
					const triggers = yield* triggersOf(rows.map((row) => row.id));
					return rows.map((row) => toAutomation(row, triggers.get(row.id) ?? []));
				}),
			),

		list: ({ projectId }) =>
			operation(
				"list",
				Effect.gen(function* () {
					const standing = yield* authorization.project(projectId, "automation.read");
					const { project: owner } = standing;
					const owned = and(
						eq(automation.workspaceId, owner.workspaceId),
						eq(automation.projectId, owner.id),
						isNull(automation.deletedAt),
					);
					// Somebody who manages a bot they don't reach, as an administrator does a
					// private bot, reads how its automations are set up but not how they ran.
					if (!standing.may("automation.history.read")) {
						const definitions = yield* query((db) =>
							db
								.select()
								.from(automation)
								.where(owned)
								.orderBy(asc(automation.name), asc(automation.id)),
						);
						const triggers = yield* triggersOf(definitions.map((row) => row.id));
						return definitions.map((row) => toAutomation(row, triggers.get(row.id) ?? []));
					}
					const rows = yield* query((db) => listedRows(db, owned));
					const triggers = yield* triggersOf(rows.map((row) => row.automation.id));
					return rows.map(
						(row): ListedAutomationDefinition => ({
							...toAutomation(row.automation, triggers.get(row.automation.id) ?? []),
							status: toListStatus(row),
						}),
					);
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
					return yield* runsPage(eq(automationRun.automationId, scope.automationId), page);
				}),
			),

		listProjectRuns: ({ projectId }, page = { limit: DEFAULT_RUN_PAGE_LIMIT }) =>
			operation(
				"listProjectRuns",
				Effect.gen(function* () {
					const { project: owner } = yield* authorization.project(
						projectId,
						"automation.history.read",
					);
					return yield* runsPage(eq(automation.projectId, owner.id), page);
				}),
			),
	} satisfies ViewMethods;
});

/**
 * The automations `which` picks, by name, each with its latest run and whether
 * it is failing, for {@link toListStatus}.
 */
const listedRows = (db: Executor, which: SQL | undefined) => {
	const latest = latestRunOf(db);
	return db
		.select({ automation, ...listStatusColumns(latest) })
		.from(automation)
		.leftJoinLateral(latest, sql`true`)
		.where(which)
		.orderBy(asc(automation.name), asc(automation.id));
};

type ViewMethods = Pick<
	Automations.Interface,
	"listInWorkspace" | "list" | "get" | "listRuns" | "listProjectRuns"
>;

/**
 * A page of the runs `which` picks, by the run and its automation, newest first. A removed automation keeps
 * its runs, so they are listed as long as it was ever defined.
 */
const runsPage = (which: SQL, page: RunPageQuery) =>
	Effect.gen(function* () {
		const before = page.cursor ? yield* executionCursor(page.cursor) : undefined;
		const rows = yield* query((db) =>
			db
				.select({
					run: automationRun,
					rootConversationId: placedConversation.rootConversationId,
					posted: resultPosted(automationRun.id),
				})
				.from(automationRun)
				.innerJoin(automation, eq(automation.id, automationRun.automationId))
				.innerJoin(placedConversation, eq(placedConversation.id, automationRun.conversationId))
				.where(
					and(
						which,
						before ? earlierThan(automationRun.acceptedAt, automationRun.id, before) : undefined,
					),
				)
				.orderBy(desc(automationRun.acceptedAt), desc(automationRun.id))
				.limit(page.limit + 1),
		);
		const items = rows.slice(0, page.limit);
		const oldest = items.at(-1)?.run;
		return {
			items: items.map(({ run, rootConversationId, posted }) => {
				if (!rootConversationId) throw new Error(`Automation run ${run.id} is in no conversation`);
				return toRun(run, rootConversationId, posted);
			}),
			nextCursor:
				rows.length > page.limit && oldest
					? encodeCursor({ at: oldest.acceptedAt, id: oldest.id })
					: null,
		};
	});

export class InvalidRunCursor extends Data.TaggedError("InvalidRunCursor") implements UserFacing {
	get userMessage() {
		return userText`That automation run cursor is invalid`;
	}
}

const executionCursor = (cursor: string) => {
	const point = decodeCursor(cursor);
	return point ? Effect.succeed(point) : Effect.fail(new InvalidRunCursor());
};
