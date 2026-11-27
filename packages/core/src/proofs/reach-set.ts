import { inArray, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import {
	reachedBotUntilDeletionFor,
	reachesBotFor,
	reachesChatFor,
	reachesProjectFor,
} from "../authorization/access.ts";
import { bot, project, projectBot } from "../database/schema.ts";
import { outerColumn } from "../database/sql.ts";
import type { BotPrincipal, Principal } from "../principal.ts";
import { admittedProjectReach, botRemovalStarted } from "./facts.ts";
import type { InWorkspace } from "./in-workspace.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import { webhookReachesChat } from "./webhook-chats.ts";

/** The columns of a chat, or an alias of `placedChat`, that whether it is reached is decided from. */
export interface ChatColumns {
	readonly id: SQLWrapper;
	readonly kind: SQLWrapper;
	readonly rootChatId: SQLWrapper;
	readonly projectId: SQLWrapper;
}

/**
 * The projects, chats and bots P reaches in the workspace W, within its
 * bounds, as SQL that list services filter by: what reaching each one alone
 * would allow, so a list across projects, such as search, shows a bot's
 * asker nothing outside the turn's bounds.
 */
export interface ReachSet<P, W> extends Proof<"ReachSet", [P, W]> {
	readonly principal: Named<P, Principal>;
	readonly workspace: Named<W, string>;
	/** SQL for "P reaches this project of W", given the column naming it. */
	readonly reachesProject: (projectId: SQLWrapper) => SQL<boolean>;
	/** SQL for "P reaches this chat of W", given its columns. */
	readonly reachesChat: (chat: ChatColumns) => SQL<boolean>;
	/** SQL for "P reaches this bot of W", given the column naming it. */
	readonly reachesBot: (botId: SQLWrapper) => SQL<boolean>;
	/**
	 * SQL for "P hears about this bot of W": reaches it, or, as a member, did
	 * until its deletion began, so a stream tells them it is going.
	 */
	readonly hearsAboutBot: (botId: SQLWrapper) => SQL<boolean>;
}

const ReachSetProof = defineProof("ReachSet");

const never = () => sql<boolean>`false`;

/** SQL for "the project `projectId` names is in the workspace `workspaceId`". */
const projectInWorkspace = (projectId: SQLWrapper, workspaceId: string) =>
	sql<boolean>`exists (
		select 1 from ${project} as reach_set_project
		where reach_set_project.id = ${outerColumn(projectId)} and reach_set_project.workspace_id = ${workspaceId}::uuid
	)`;

/**
 * SQL for "the bot `botId` reaches the project `projectId` names": one it is
 * in or leads, or its own default project; a personal bot, whatever its
 * creator reaches, so only acting for `askerId`.
 */
const botReachesProject = (projectId: SQLWrapper, botId: string, askerId: string | null) =>
	sql<boolean>`(not ${botRemovalStarted(sql`${botId}::uuid`)} and (
		exists (
			select 1 from ${bot} as reach_set_personal
			where reach_set_personal.id = ${botId}::uuid and reach_set_personal.visibility = 'personal'
				and reach_set_personal.created_by_id = ${askerId}::uuid
		)
		or exists (
			select 1 from ${project} as reach_set_led
			where reach_set_led.id = ${outerColumn(projectId)}
				and (reach_set_led.lead_bot_id = ${botId}::uuid or reach_set_led.default_of_bot_id = ${botId}::uuid)
		)
		or exists (
			select 1 from ${projectBot} as reach_set_bot
			where reach_set_bot.project_id = ${outerColumn(projectId)} and reach_set_bot.bot_id = ${botId}::uuid
		)
	))`;

/** SQL for "the bot `botId` names is the bot `ownBotId`, or one the project `projectId` has". */
const ownOrProjectBot = (botId: SQLWrapper, ownBotId: string, projectId: string) =>
	sql<boolean>`(${outerColumn(botId)} = ${ownBotId}::uuid or ${projectHasBot(projectId, botId)})`;

/** SQL for "the project `projectId` has the bot `botId` names: its lead, one of its bots, or its own bot". */
const projectHasBot = (projectId: string, botId: SQLWrapper) =>
	sql<boolean>`exists (
		select 1 from ${project} as reach_set_bounds
		where reach_set_bounds.id = ${projectId}::uuid
			and (reach_set_bounds.lead_bot_id = ${outerColumn(botId)} or reach_set_bounds.default_of_bot_id = ${outerColumn(botId)}
				or exists (
					select 1 from ${projectBot} as reach_set_bounds_bot
					where reach_set_bounds_bot.project_id = reach_set_bounds.id and reach_set_bounds_bot.bot_id = ${outerColumn(botId)}
				))
	)`;

function admittedPredicates(
	principal: BotPrincipal,
	admission: NonNullable<BotPrincipal["admission"]>,
) {
	const { bounds } = principal;
	const projects = Object.values(admission.projects);
	const reachedProjects = Object.keys(admission.projects).filter(
		(projectId) => admittedProjectReach(principal, projectId) === "reaches",
	);
	const reachedBots =
		principal._tag === "AutomationRun"
			? admission.chatProjectBotIds
			: projects.flatMap(({ project, memberReaches }) =>
					project.defaultOf && memberReaches ? [project.defaultOf.id] : [],
				);
	const projectIsActive = (projectId: SQLWrapper) => sql<boolean>`exists (
		select 1 from ${project} as admitted_project
		where admitted_project.id = ${outerColumn(projectId)} and not admitted_project.deleting
	)`;
	const reachesProject = (projectId: SQLWrapper) =>
		sql<boolean>`(${inArray(outerColumn(projectId), reachedProjects)} and ${projectIsActive(projectId)})`;
	return {
		reachesProject,
		reachesChat: (chat: ChatColumns) => reachesProject(chat.projectId),
		reachesBot: (botId: SQLWrapper) =>
			sql<boolean>`(${inArray(outerColumn(botId), reachedBots)}
				and not ${botRemovalStarted(botId)}
				and ${principal._tag === "AutomationRun" ? projectIsActive(sql`${principal.bounds.project}::uuid`) : sql`true`}
				and ${bounds.kind === "member" ? sql`true` : inArray(outerColumn(botId), admission.chatProjectBotIds)})`,
	};
}

/** The predicates for `principal`, before each is kept to the workspace. */
function predicatesOf(principal: Principal) {
	switch (principal._tag) {
		case "MemberSession":
			return {
				reachesProject: (projectId: SQLWrapper) => reachesProjectFor(projectId, principal.member),
				reachesChat: (chat: ChatColumns) => reachesChatFor(chat, principal.member),
				reachesBot: (botId: SQLWrapper) => reachesBotFor(botId, principal.member),
			};
		case "BotForAsker": {
			if (principal.admission) return admittedPredicates(principal, principal.admission);
			const { asker, bounds } = principal;
			const withinBounds = (projectId: SQLWrapper) =>
				bounds.kind === "member"
					? sql<boolean>`true`
					: sql<boolean>`${outerColumn(projectId)} = ${bounds.project}::uuid`;
			return {
				reachesProject: (projectId: SQLWrapper) =>
					sql<boolean>`(${withinBounds(projectId)} and ${reachesProjectFor(projectId, asker)} and ${botReachesProject(projectId, principal.bot, asker)})`,
				reachesChat: (chat: ChatColumns) =>
					sql<boolean>`(${withinBounds(chat.projectId)} and ${reachesChatFor(chat, asker)} and ${botReachesProject(chat.projectId, principal.bot, asker)})`,
				reachesBot: (botId: SQLWrapper) =>
					bounds.kind === "member"
						? reachesBotFor(botId, asker)
						: sql<boolean>`(${reachesBotFor(botId, asker)} and ${ownOrProjectBot(botId, principal.bot, bounds.project)})`,
			};
		}
		case "AutomationRun": {
			if (principal.admission) return admittedPredicates(principal, principal.admission);
			const { project: runProject } = principal.bounds;
			const runProjectIsActive = sql<boolean>`exists (
				select 1 from ${project} as reach_set_run_project
				where reach_set_run_project.id = ${runProject}::uuid
					and not reach_set_run_project.deleting
			)`;
			const reachesProject = (projectId: SQLWrapper) =>
				sql<boolean>`(${outerColumn(projectId)} = ${runProject}::uuid
					and ${runProjectIsActive}
					and ${botReachesProject(projectId, principal.bot, null)})`;
			return {
				reachesProject,
				reachesChat: (chat: ChatColumns) => reachesProject(chat.projectId),
				reachesBot: (botId: SQLWrapper) =>
					sql<boolean>`(${runProjectIsActive}
						and ${ownOrProjectBot(botId, principal.bot, runProject)}
						and not ${botRemovalStarted(botId)}
						and exists (
						select 1 from ${bot} as reach_set_talked where reach_set_talked.id = ${outerColumn(botId)} and reach_set_talked.system_bot_key is null
					))`,
			};
		}
		case "WebhookCall":
			return {
				reachesProject: never,
				reachesChat: (chat: ChatColumns) => webhookReachesChat(principal, chat.id),
				reachesBot: never,
			};
		case "SystemWork": {
			const { work } = principal;
			return {
				reachesProject: never,
				reachesChat: (chat: ChatColumns) =>
					work.kind === "compaction"
						? sql<boolean>`${outerColumn(chat.id)} = ${work.chat}::uuid`
						: never(),
				reachesBot: never,
			};
		}
		case "PageAddress":
			return { reachesProject: never, reachesChat: never, reachesBot: never };
	}
}

export const projectReachPredicate = (principal: Principal, projectId: SQLWrapper): SQL<boolean> =>
	predicatesOf(principal).reachesProject(projectId);

export const proveReachSet = <P, W>(inWorkspace: InWorkspace<P, W>): ReachSet<P, W> => {
	const workspaceId = inWorkspace.workspace.value;
	const predicates = predicatesOf(inWorkspace.principal.value);
	const inWorkspaceBot = (botId: SQLWrapper) =>
		sql<boolean>`exists (select 1 from ${bot} as reach_set_workspace_bot where reach_set_workspace_bot.id = ${outerColumn(botId)} and reach_set_workspace_bot.workspace_id = ${workspaceId}::uuid)`;
	return ReachSetProof.prove([inWorkspace.principal, inWorkspace.workspace], {
		principal: inWorkspace.principal,
		workspace: inWorkspace.workspace,
		reachesProject: (projectId: SQLWrapper) =>
			sql<boolean>`(${projectInWorkspace(projectId, workspaceId)} and ${predicates.reachesProject(projectId)})`,
		reachesChat: (chat: ChatColumns) =>
			sql<boolean>`(${projectInWorkspace(chat.projectId, workspaceId)} and ${predicates.reachesChat(chat)})`,
		reachesBot: (botId: SQLWrapper) =>
			sql<boolean>`(${inWorkspaceBot(botId)} and ${predicates.reachesBot(botId)})`,
		hearsAboutBot: (botId: SQLWrapper) => {
			const principal = inWorkspace.principal.value;
			const hears =
				principal._tag === "MemberSession"
					? reachedBotUntilDeletionFor(botId, principal.member)
					: predicates.reachesBot(botId);
			return sql<boolean>`(${inWorkspaceBot(botId)} and ${hears})`;
		},
	});
};
