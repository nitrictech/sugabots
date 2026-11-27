/**
 * Who answers a call that waits for approval, by the first rule that fits,
 * written once as SQL. `CanDecide` and `Approved` ask it of one member and
 * one call, `CanInterrupt` of a run's turn, and the lists of approvals waiting
 * on a member select by it, so all of them decide alike. It makes no proof.
 *
 * What the rule takes from the grant tables, who manages which project and
 * bot and who is an admin, is decided by the provers' own rules
 * (`managesProject`, `managesBot`, `administers`) and handed to the SQL as an
 * {@link ApproverStanding}.
 */

import type { WorkspaceRole } from "@sugabots/contracts";
import { inArray, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { TurnFacts } from "../authentication/turn-facts.ts";
import { isBotMember, reachesChatFor } from "../authorization/access.ts";
import { COMPUTER_REQUEST_TOOLS } from "../chats/tools/approvers.ts";
import { type Executor, query } from "../database/database.ts";
import {
	automationRun,
	bot,
	membership,
	placedChat,
	project,
	projectMember,
	toolCall,
	turn,
	workspace,
} from "../database/schema.ts";
import { outerColumn } from "../database/sql.ts";
import {
	actorOf,
	administers,
	botRecord,
	managesBot,
	managesProject,
	memberReaches,
	type ProjectFacts,
	reachFacts,
	reachFactsIn,
	roleIn,
} from "./facts.ts";
import type { ChatColumns } from "./reach-set.ts";

/**
 * The approver rule for a call, by the first that fits.
 *
 * 1. `computerRequest`: a request to change a computer, such as a host
 *    request: those who may manage the computer's project.
 * 2. `personalBot`: a personal bot's call, or one in its runs: only its
 *    creator, whose permissions it acts with.
 * 3. `run`: a call in an automation's run: admins and the managers of the
 *    run's bot, among those who reach its chat.
 * 4. `asker`: any other turn's call, a helper's included: its asker, while they reach the chat.
 */
export type ApproverRule = "computerRequest" | "personalBot" | "run" | "asker";

/**
 * A call that waits for approval, or one a turn would make: the turn making
 * it, and whether it asks to change a computer. Columns of an outer query, or
 * values.
 */
interface AskedApproval {
	readonly turnId: SQLWrapper;
	readonly computerRequest: SQL<boolean>;
	readonly computerProjectId?: SQLWrapper;
}

/**
 * What a member approves by the grant tables rather than by who they are:
 * the projects whose computer requests they decide, those they manage;
 * whether they are an admin; and the bots whose runs' calls they decide, those
 * they manage, in the chats `reachesChat` says they reach.
 */
export interface ApproverStanding {
	readonly member: string;
	readonly managedProjects: readonly string[];
	readonly administers: boolean;
	readonly managedBots: readonly string[];
	readonly reachesChat: (chat: ChatColumns) => SQL<boolean>;
}

/** The call to the tool `tool` names, made in the turn `turnId` names. */
export function askedCall(call: {
	tool: SQLWrapper;
	turnId: SQLWrapper;
	approvalComputerProjectId: SQLWrapper;
}): AskedApproval {
	return {
		turnId: call.turnId,
		computerRequest: asksToChangeComputer(call.tool),
		computerProjectId: call.approvalComputerProjectId,
	};
}

/** SQL for whether the member `standing` describes approves `asked`. */
export function approvedBy(standing: ApproverStanding, asked: AskedApproval): SQL<boolean> {
	return sql<boolean>`coalesce((
		select ${approvalDecision(standing, approverRule(asked.computerRequest), asked.computerProjectId)}
		${fromApproverTurn(asked.turnId)}
	), false)`;
}

/**
 * The ids in `candidates` that `standing` may approve. Candidates supply
 * `id`, `turn_id`, `tool` and `approval_computer_project_id`.
 */
export function approvedCalls(standing: ApproverStanding, candidates: SQLWrapper): SQL {
	const turnApproval = approvalDecision(standing, approverRule(sql<boolean>`false`));
	return sql`with pending_calls as (${candidates}),
		turn_decisions as materialized (
			select approver_turn.id as turn_id, ${turnApproval} as allowed
			from (select distinct turn_id from pending_calls) as pending_turns
			inner join ${turn} as approver_turn on approver_turn.id = pending_turns.turn_id
			${approverTurnRelations}
		)
		select pending_calls.id
		from pending_calls
		inner join turn_decisions using (turn_id)
		where case when ${asksToChangeComputer(sql`pending_calls.tool`)}
			then ${isOneOf(sql`pending_calls.approval_computer_project_id`, standing.managedProjects)}
			else turn_decisions.allowed
		end`;
}

/**
 * SQL for whether the tool `tool` names asks to change a computer: one of
 * `COMPUTER_REQUEST_TOOLS`, which includes operations whose exposure calls
 * for computer managers to decide.
 */
function asksToChangeComputer(tool: SQLWrapper): SQL<boolean> {
	return sql<boolean>`${outerColumn(tool)} in (${sql.join(
		COMPUTER_REQUEST_TOOLS.map((name) => sql`${name}`),
		sql`, `,
	)})`;
}

/**
 * The standing of the member `memberId` across the workspace `workspaceId`,
 * for a list of what they approve in the chats `reachesChat` reaches.
 */
export const approverStandingIn = (
	db: Executor,
	workspaceId: string,
	memberId: string,
	reachesChat: (chat: ChatColumns) => SQL<boolean>,
) =>
	Effect.gen(function* () {
		const role = yield* roleIn(db, workspaceId, memberId);
		const places = yield* reachFactsIn(db, workspaceId, { member: memberId });
		const standing: ApproverStanding = {
			member: memberId,
			managedProjects: places.flatMap(({ project, member }) =>
				member && managesProject(member, project) ? [project.id] : [],
			),
			administers: administers(actorOf(memberId, role)),
			// Every bot members talk to has a default project, which names it.
			managedBots: places.flatMap(({ project, member }) =>
				member && project.defaultOf && managesBot(member.actor, project.defaultOf)
					? [project.defaultOf.id]
					: [],
			),
			reachesChat,
		};
		return standing;
	});

/**
 * The standing of the member `memberId` towards the calls made in a chat of
 * the project `where.project`, in a run the bot `where.runBot` does if the
 * chat is a run's, and whether they reach that chat.
 */
export const approverStandingWhere = (
	db: Executor,
	memberId: string,
	where: {
		readonly project: string | null;
		readonly runBot: string | null;
		readonly computerProjectId?: string | undefined;
	},
) =>
	Effect.gen(function* () {
		const { project, runBot: runBotId, computerProjectId } = where;
		const reach = project ? yield* reachFacts(db, project, { member: memberId }) : undefined;
		const place = reach?.member;
		const reachesChat = reach !== undefined && memberReaches(place, reach.project);
		const runBot = runBotId ? yield* botRecord(db, runBotId, { member: memberId }) : undefined;
		const standing: ApproverStanding = {
			member: memberId,
			managedProjects: computerProjectId
				? yield* managedComputerProjects(db, memberId, computerProjectId)
				: [],
			administers: place !== undefined && administers(place.actor),
			managedBots:
				runBot?.defaultProject && !runBot.deleting && place && managesBot(place.actor, runBot)
					? [runBot.id]
					: [],
			reachesChat: () => sql<boolean>`${reachesChat}::boolean`,
		};
		return { standing, reachesChat };
	});

const managedComputerProjects = (db: Executor, memberId: string, projectId: string) =>
	Effect.gen(function* () {
		const reach = yield* reachFacts(db, projectId, { member: memberId });
		return reach?.member && managesProject(reach.member, reach.project) ? [projectId] : [];
	});

const approverStandingAt = (
	db: Executor,
	memberId: string,
	facts: TurnFacts,
	computerProjectId?: string,
) =>
	approverStandingWhere(db, memberId, {
		project: facts.project,
		runBot: facts.run?.bot ?? null,
		computerProjectId,
	});

export const approverFacts = (memberId: string, facts: TurnFacts, computerProjectId?: string) =>
	Effect.gen(function* () {
		const { standing, reachesChat } = yield* query((db) =>
			approverStandingAt(db, memberId, facts, computerProjectId),
		);
		const rule = approverRule(sql<boolean>`${computerProjectId !== undefined}::boolean`);
		const [decided] = yield* query((db) =>
			db.execute<{ rule: ApproverRule; approver: boolean }>(
				sql`select ${rule} as rule, coalesce(${approvalDecision(
					standing,
					rule,
					computerProjectId ? sql`${computerProjectId}::uuid` : undefined,
				)}, false) as approver
					${fromApproverTurn(sql`${facts.turn}::uuid`)}`,
				"objects",
			),
		);
		return {
			rule: decided?.rule ?? "asker",
			approver: decided?.approver ?? false,
			reachesChat,
		};
	});

/**
 * Members who can decide each call, with whether they also reach its chat.
 * Callers must use fixed fields when delivering a call outside its chat.
 */
export const approvalAudience = Effect.fn("Approvers.approvalAudience")(function* (
	db: Executor,
	callIds: readonly string[],
	recipientId?: string,
) {
	if (callIds.length === 0) return [];
	const member = sql`audience.member_id`;
	const rule = approverRule(asksToChangeComputer(sql`candidates.tool`));
	const reachesChat = reachesChatFor(APPROVER_CHAT, member);
	type Call = Pick<typeof toolCall.$inferSelect, "id" | "tool" | "input" | "executionInput">;
	const rows = yield* db.execute<
		Call & {
			memberId: string;
			role: WorkspaceRole;
			rule: ApproverRule;
			reachesChat: boolean;
			runBot: ProjectFacts["defaultOf"];
			computerBot: ProjectFacts["defaultOf"];
			inComputerProject: boolean;
		}
	>(
		sql`with candidates as (
			select * from ${toolCall} where ${inArray(toolCall.id, callIds)}
		)
		select ${member} as "memberId", audience.role, ${rule} as rule, ${reachesChat} as "reachesChat",
			${selectBotFacts(sql`run_bot`, member)} as "runBot",
			${selectBotFacts(sql`computer_bot`, member)} as "computerBot",
			exists (
				select 1 from ${projectMember} as computer_member
				where computer_member.project_id = computer_project.id and computer_member.member_id = ${member}
			) as "inComputerProject",
			candidates.id, candidates.tool, candidates.input, candidates.execution_input as "executionInput"
		from candidates
		inner join ${turn} as approver_turn on approver_turn.id = candidates.turn_id
		inner join ${bot} as approver_bot on approver_bot.id = approver_turn.bot_id
		inner join lateral (
			select id, kind, root_chat_id, project_id, workspace_id from ${placedChat}
			where id = approver_turn.chat_id
			limit 1
		) as approver_chat on true
		inner join ${workspace} as audience_workspace on audience_workspace.id = approver_chat.workspace_id
			and not audience_workspace.deleting
		inner join ${membership} as audience on audience.workspace_id = audience_workspace.id and not audience.leaving
			${recipientId === undefined ? sql`` : sql`and audience.member_id = ${recipientId}::uuid`}
		left join ${automationRun} as approver_run on approver_run.chat_id = approver_turn.chat_id
		left join ${project} as run_bot_project on run_bot_project.default_of_bot_id = approver_run.bot_id
			and not run_bot_project.deleting
		left join ${bot} as run_bot on run_bot.id = run_bot_project.default_of_bot_id
		left join ${project} as computer_project on computer_project.id = candidates.approval_computer_project_id
			and computer_project.workspace_id = audience_workspace.id and not computer_project.deleting
		left join ${bot} as computer_bot on computer_bot.id = computer_project.default_of_bot_id
		where ${decidesByRule(rule, {
			member,
			managesComputer: sql<boolean>`computer_project.id is not null`,
			reachesChat,
			managesRun: sql<boolean>`true`,
		})}
		order by candidates.started_at, candidates.id`,
		"objects",
	);
	const audience = new Map<string, { memberId: string; reachesChat: boolean; calls: Call[] }>();
	for (const {
		memberId,
		role,
		rule,
		reachesChat,
		runBot,
		computerBot,
		inComputerProject,
		...call
	} of rows) {
		const actor = actorOf(memberId, role);
		if (rule === "run" && !administers(actor) && !(runBot && managesBot(actor, runBot))) continue;
		if (
			rule === "computerRequest" &&
			!managesProject({ actor, inProject: inComputerProject }, { defaultOf: computerBot })
		)
			continue;
		const key = `${memberId}/${reachesChat}`;
		const existing = audience.get(key);
		if (existing) existing.calls.push(call);
		else audience.set(key, { memberId, reachesChat, calls: [call] });
	}
	return Array.from(audience.values());
});

function selectBotFacts(bot: SQL, member: SQL): SQL {
	return sql`case when ${bot}.id is not null then json_build_object(
		'id', ${bot}.id,
		'visibility', ${bot}.visibility,
		'createdById', ${bot}.created_by_id,
		'assistantOf', ${bot}.assistant_of,
		'privateMemberId', case when ${isBotMember(sql`${bot}.id`, member)} then ${member} end
	) end`;
}

/** The turn's chat, as the SQL in {@link fromApproverTurn} names it, for a reach rule to read. */
const APPROVER_CHAT: ChatColumns = {
	id: sql`approver_chat.id`,
	kind: sql`approver_chat.kind`,
	rootChatId: sql`approver_chat.root_chat_id`,
	projectId: sql`approver_chat.project_id`,
};

function approverRule(computerRequest: SQL<boolean>): SQL<ApproverRule> {
	return sql<ApproverRule>`case
		when ${computerRequest} then 'computerRequest'
		when approver_bot.visibility = 'personal' then 'personalBot'
		when approver_turn.asked_by_automation and approver_run.id is not null then 'run'
		else 'asker'
	end`;
}

function approvalDecision(
	standing: ApproverStanding,
	rule: SQL<ApproverRule>,
	computerProjectId?: SQLWrapper,
): SQL<boolean> {
	return decidesByRule(rule, {
		member: sql`${standing.member}::uuid`,
		managesComputer: computerProjectId
			? isOneOf(sql`${outerColumn(computerProjectId)}`, standing.managedProjects)
			: sql<boolean>`false`,
		managesRun: sql<boolean>`(${standing.administers}::boolean or ${isOneOf(sql`approver_run.bot_id`, standing.managedBots)})`,
		reachesChat: standing.reachesChat(APPROVER_CHAT),
	});
}

function decidesByRule(
	rule: SQL<ApproverRule>,
	standing: {
		member: SQL;
		managesComputer: SQL<boolean>;
		managesRun: SQL<boolean>;
		reachesChat: SQL<boolean>;
	},
): SQL<boolean> {
	return sql<boolean>`case ${rule}
		when 'computerRequest' then ${standing.managesComputer}
		when 'personalBot' then approver_bot.created_by_id = ${standing.member}
		when 'run' then ${standing.managesRun} and ${standing.reachesChat}
		else approver_turn.asker_id = ${standing.member} and ${standing.reachesChat}
	end`;
}

const approverTurnRelations = sql`
	inner join ${bot} as approver_bot on approver_bot.id = approver_turn.bot_id
	inner join ${placedChat} as approver_chat on approver_chat.id = approver_turn.chat_id
	left join ${automationRun} as approver_run on approver_run.chat_id = approver_turn.chat_id
`;

function fromApproverTurn(turnId: SQLWrapper): SQL {
	return sql`from ${turn} as approver_turn
		${approverTurnRelations}
		where approver_turn.id = ${outerColumn(turnId)}`;
}

/** SQL for whether `column` is one of `ids`: `false` for none, as `in ()` is not valid SQL. */
function isOneOf(column: SQL, ids: readonly string[]): SQL<boolean> {
	if (ids.length === 0) return sql<boolean>`false`;
	return sql<boolean>`${column} in (${sql.join(
		ids.map((id) => sql`${id}::uuid`),
		sql`, `,
	)})`;
}
