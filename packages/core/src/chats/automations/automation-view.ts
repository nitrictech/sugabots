import {
	DEFAULT_RUN_PAGE_LIMIT,
	type ListedAutomationDefinition,
	type RunPageQuery,
} from "@sugabots/contracts";
import { and, asc, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { Effect } from "effect";
import { Authorization } from "../../authorization/authorization.ts";
import { type Executor, query, serviceOperations } from "../../database/database.ts";
import { automation, automationRun, placedChat } from "../../database/schema.ts";
import { earlierThan, encodeCursor, parseCursor } from "../cursor.ts";
import { toAutomation, triggersOf } from "./automation.ts";
import type { Automations } from "./automations.ts";
import { latestRunOf, listStatusColumns, resultPosted, toListStatus, toRun } from "./execution.ts";

/** What the legacy `Automations.Service` shows a tool: its `list`. */
export const makeView = Effect.gen(function* () {
	const operation = yield* serviceOperations<ViewMethods>("Automations");
	const authorization = yield* Authorization.Service;

	return {
		list: ({ projectId }) =>
			operation(
				"list",
				Effect.gen(function* () {
					const standing = yield* authorization.project(projectId, "automation.read");
					const { project } = standing;
					// Somebody who manages a bot they don't reach, as an admin does a
					// personal bot, reads how its automations are set up but not how they ran.
					return yield* automationsOf(
						{ workspaceId: project.workspaceId, projectId: project.id },
						{ withStatus: standing.may("automation.history.read") },
					);
				}),
			),
	} satisfies ViewMethods;
});

/**
 * The project's automations, by name, as they are set up, each with how it
 * stands when `withStatus`: its latest run and whether it is failing, which
 * only those who may read how its runs went are shown.
 */
export const automationsOf = (
	project: { readonly workspaceId: string; readonly projectId: string },
	{ withStatus }: { readonly withStatus: boolean },
) =>
	Effect.gen(function* () {
		const owned = and(
			eq(automation.workspaceId, project.workspaceId),
			eq(automation.projectId, project.projectId),
			isNull(automation.deletedAt),
		);
		if (!withStatus) {
			const definitions = yield* query((db) =>
				db.select().from(automation).where(owned).orderBy(asc(automation.name), asc(automation.id)),
			);
			const triggers = yield* triggersOf(definitions.map((row) => row.id));
			return definitions.map(
				(row): ListedAutomationDefinition => toAutomation(row, triggers.get(row.id) ?? []),
			);
		}
		const rows = yield* query((db) => listedRows(db, owned));
		const triggers = yield* triggersOf(rows.map((row) => row.automation.id));
		return rows.map(
			(row): ListedAutomationDefinition => ({
				...toAutomation(row.automation, triggers.get(row.automation.id) ?? []),
				status: toListStatus(row),
			}),
		);
	});

/**
 * A page of the runs of every automation of the project, newest first,
 * removed automations' included.
 */
export const projectRunsPage = (
	projectId: string,
	page: RunPageQuery = { limit: DEFAULT_RUN_PAGE_LIMIT },
) => runsPage(eq(automation.projectId, projectId), page);

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

type ViewMethods = Pick<Automations.Interface, "list">;

/**
 * A page of the runs `which` picks, by the run and its automation, newest first. A removed automation keeps
 * its runs, so they are listed as long as it was ever defined.
 */
const runsPage = (which: SQL, page: RunPageQuery) =>
	Effect.gen(function* () {
		const before = page.cursor ? yield* parseCursor(page.cursor) : undefined;
		const rows = yield* query((db) =>
			db
				.select({
					run: automationRun,
					rootChatId: placedChat.rootChatId,
					posted: resultPosted(automationRun.id),
				})
				.from(automationRun)
				.innerJoin(automation, eq(automation.id, automationRun.automationId))
				.innerJoin(placedChat, eq(placedChat.id, automationRun.chatId))
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
			items: items.map(({ run, rootChatId, posted }) => {
				if (!rootChatId) throw new Error(`Automation run ${run.id} is in no chat`);
				return toRun(run, rootChatId, posted);
			}),
			nextCursor:
				rows.length > page.limit && oldest
					? encodeCursor({ at: oldest.acceptedAt, id: oldest.id })
					: null,
		};
	});
