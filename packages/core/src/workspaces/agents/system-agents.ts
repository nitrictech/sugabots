import type { AgentColor, AgentFace, SystemAgentKey } from "@sugabots/contracts";
import { and, eq, isNotNull } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor } from "../../database/database.ts";
import { agent } from "../../database/schema.ts";

/**
 * System agents are protected agents the product runs. A workspace owns one of
 * each, and every pod in it is served by them: they sit in no pod, and a pod has
 * nothing to place, configure or remove.
 *
 * One is born without a model, since a new workspace offers none, and is given
 * the first model somebody switches on, which is the one they pick while
 * onboarding. From then on it always has one: an administrator can change it
 * but not clear it, and the workspace cannot stop offering it until the agent
 * is moved to another. Compaction runs on the model of the bot it compacts
 * for, and on its own only for a bot with none.
 */

export type { SystemAgentKey };

/** The system agent that keeps thread summaries and titles up to date. */
export const SUMMARISE_SYSTEM_AGENT: SystemAgentKey = "summarise";

/** The system agent that decides who speaks next when nobody was addressed. */
export const FACILITATE_SYSTEM_AGENT: SystemAgentKey = "facilitate";

/** The system agent that compacts what a bot reads when its conversation gets long. */
export const COMPACT_SYSTEM_AGENT: SystemAgentKey = "compact";

export interface SystemAgentDefinition {
	/** What the system looks the agent up by. */
	key: SystemAgentKey;
	name: string;
	description: string;
	color: AgentColor;
	face: AgentFace;
	prompt: string;
}

export const SYSTEM_AGENTS: readonly SystemAgentDefinition[] = [
	{
		key: SUMMARISE_SYSTEM_AGENT,
		name: "Scribe",
		description: "Keeps concise summaries of ongoing conversations.",
		color: "orange",
		face: "arc",
		prompt: "Summarize conversations accurately and concisely. Do not invent details.",
	},
	{
		key: FACILITATE_SYSTEM_AGENT,
		name: "Facilitator",
		description: "Decides who speaks next when nobody was addressed.",
		color: "teal",
		face: "pill",
		prompt:
			"Keep the conversation on track: bring in the agent who can answer, and let it rest when the question has been answered.",
	},
	{
		key: COMPACT_SYSTEM_AGENT,
		name: "Compaction",
		description: "Compacts long conversations so bots can keep reading them.",
		color: "purple",
		face: "square",
		prompt: "Summarize what a bot needs to carry on the conversation. Do not invent details.",
	},
];

/** The workspace's system agent and the model chosen for it, if any. */
export const findSystemAgent = Effect.fn("SystemAgents.findSystemAgent")(function* (
	db: Executor,
	workspaceId: string,
	key: SystemAgentKey,
) {
	const [row] = yield* db
		.select({ id: agent.id, model: agent.model })
		.from(agent)
		.where(and(eq(agent.workspaceId, workspaceId), eq(agent.systemAgentKey, key)))
		.limit(1);
	return row;
});

/**
 * The system agent and the model it runs on, or nothing when no model has been
 * chosen, which is what "set up" means for one. A caller cannot reach a system
 * agent and forget that it may not be set up: here `undefined` is the whole
 * answer, and what comes back names a model.
 */
export const findRunnableSystemAgent = Effect.fn("SystemAgents.findRunnableSystemAgent")(function* (
	db: Executor,
	workspaceId: string,
	key: SystemAgentKey,
) {
	const [row] = yield* db
		.select({ id: agent.id, model: agent.model })
		.from(agent)
		.where(
			and(
				eq(agent.workspaceId, workspaceId),
				eq(agent.systemAgentKey, key),
				isNotNull(agent.model),
			),
		)
		.limit(1);
	return row?.model == null ? undefined : { id: row.id, model: row.model };
});
