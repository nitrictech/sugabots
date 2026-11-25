import {
	DEFAULT_RUN_PAGE_LIMIT,
	type ListedAutomationDefinition,
	type RestrictableAutomation,
	type RunPageQuery,
} from "@sugabots/contracts";
import { and, asc, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { Effect } from "effect";
import { type Executor, query } from "../../database/database.ts";
import { automation, automationRun, placedChat } from "../../database/schema.ts";
import { earlierThan, encodeCursor, parseCursor } from "../cursor.ts";
import { toAutomation, triggersOf } from "./automation.ts";
import { latestRunOf, listStatusColumns, resultPosted, toListStatus, toRun } from "./execution.ts";

/**
 * automationsOf lists a reached project's automations by name, with their
 * instructions, triggers, latest run and whether they are failing.
 */
export const automationsOf = (project: {
	readonly workspaceId: string;
	readonly projectId: string;
}) =>
	Effect.gen(function* () {
		const rows = yield* query((db) => listedRows(db, automationsIn(project)));
		const triggers = yield* triggersOf(rows.map((row) => row.automation.id));
		return rows.map(
			(row): ListedAutomationDefinition => ({
				...toAutomation(row.automation, triggers.get(row.automation.id) ?? []),
				status: toListStatus(row),
			}),
		);
	});

const automationsIn = (project: { readonly workspaceId: string; readonly projectId: string }) =>
	and(
		eq(automation.workspaceId, project.workspaceId),
		eq(automation.projectId, project.projectId),
		isNull(automation.deletedAt),
	);

export const restrictableAutomations = (project: {
	readonly workspaceId: string;
	readonly projectId: string;
}) =>
	query((db) =>
		db
			.select({ id: automation.id, name: automation.name, state: automation.state })
			.from(automation)
			.where(automationsIn(project))
			.orderBy(asc(automation.name), asc(automation.id)),
	).pipe(
		Effect.map((rows): RestrictableAutomation[] =>
			rows.map((row) => ({ ...row, restricted: true })),
		),
	);

/**
 * A page of the runs of every automation of the project, newest first,
 * removed automations' included.
 */
export const projectRunsPage = (
	workspaceId: string,
	projectId: string,
	page: RunPageQuery = { limit: DEFAULT_RUN_PAGE_LIMIT },
) =>
	runsPage(
		sql`${automation.workspaceId} = ${workspaceId} and ${automation.projectId} = ${projectId}`,
		page,
	);

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
