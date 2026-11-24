import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { reachesBotFor, reachesChatFor, reachesProjectFor } from "../authorization/access.ts";
import { bot, project, projectBot } from "../database/schema.ts";
import { outerColumn } from "../database/sql.ts";
import type { Principal } from "../principal.ts";
import type { InWorkspace } from "./in-workspace.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

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
 * in or leads, or its own default project; a Personal Assistant, whatever its
 * member reaches, so only acting for `askerId`.
 */
const botReachesProject = (projectId: SQLWrapper, botId: string, askerId: string | null) =>
	sql<boolean>`(
		exists (select 1 from ${bot} as reach_set_assistant where reach_set_assistant.id = ${botId}::uuid and reach_set_assistant.assistant_of = ${askerId}::uuid)
		or exists (
			select 1 from ${project} as reach_set_led
			where reach_set_led.id = ${outerColumn(projectId)}
				and (reach_set_led.lead_bot_id = ${botId}::uuid or reach_set_led.default_of_bot_id = ${botId}::uuid)
		)
		or exists (
			select 1 from ${projectBot} as reach_set_bot
			where reach_set_bot.project_id = ${outerColumn(projectId)} and reach_set_bot.bot_id = ${botId}::uuid
		)
	)`;

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
			const { project: runProject } = principal.bounds;
			return {
				reachesProject: (projectId: SQLWrapper) =>
					sql<boolean>`(${outerColumn(projectId)} = ${runProject}::uuid and ${botReachesProject(projectId, principal.bot, null)})`,
				reachesChat: (chat: ChatColumns) =>
					sql<boolean>`(${outerColumn(chat.projectId)} = ${runProject}::uuid and ${botReachesProject(chat.projectId, principal.bot, null)})`,
				reachesBot: (botId: SQLWrapper) =>
					sql<boolean>`(${ownOrProjectBot(botId, principal.bot, runProject)} and exists (
						select 1 from ${bot} as reach_set_talked where reach_set_talked.id = ${outerColumn(botId)} and reach_set_talked.system_bot_key is null
					))`,
			};
		}
		case "WebhookCall": {
			const signedProject = principal.source.project;
			return {
				reachesProject: (projectId: SQLWrapper) =>
					sql<boolean>`${outerColumn(projectId)} = ${signedProject}::uuid`,
				reachesChat: (chat: ChatColumns) =>
					sql<boolean>`${outerColumn(chat.projectId)} = ${signedProject}::uuid`,
				reachesBot: never,
			};
		}
		case "SystemWork": {
			const { work } = principal;
			return {
				reachesProject: (projectId: SQLWrapper) =>
					work.kind === "compaction"
						? never()
						: sql<boolean>`${outerColumn(projectId)} = ${work.project}::uuid`,
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
	});
};
