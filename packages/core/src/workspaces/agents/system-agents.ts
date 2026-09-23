import type { AgentFace, SystemAgent, SystemAgentKey } from "@sugabots/contracts";
import { handleFromName } from "@sugabots/contracts";
import { and, eq, isNotNull } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor } from "../../database/database.ts";
import { agent } from "../../database/schema.ts";

/**
 * System agents are protected agents the product runs. A workspace owns one of
 * each, and every pod in it is served by them: they sit in no pod, and a pod has
 * nothing to place, configure or remove.
 *
 * One is born without a model and does not run until an administrator chooses
 * one. There is no default and no fallback: an unattended agent quietly running
 * on a model nobody picked is what this arrangement exists to prevent.
 */

export type { SystemAgentKey };

/** The system agent that keeps thread summaries and titles up to date. */
export const SUMMARISE_SYSTEM_AGENT: SystemAgentKey = "summarise";

/** The system agent that decides who speaks next when nobody was addressed. */
export const FACILITATE_SYSTEM_AGENT: SystemAgentKey = "facilitate";

export interface SystemAgentDefinition {
	/** What the system looks the agent up by. */
	key: SystemAgentKey;
	name: string;
	description: string;
	hue: number;
	face: AgentFace;
	prompt: string;
}

export const SYSTEM_AGENTS: readonly SystemAgentDefinition[] = [
	{
		key: SUMMARISE_SYSTEM_AGENT,
		name: "Scribe",
		description: "Keeps concise summaries of ongoing conversations.",
		hue: 36,
		face: "smile",
		prompt: "Summarize conversations accurately and concisely. Do not invent details.",
	},
	{
		key: FACILITATE_SYSTEM_AGENT,
		name: "Facilitator",
		description: "Decides who speaks next when nobody was addressed.",
		hue: 205,
		face: "bar",
		prompt:
			"Keep the conversation on track: bring in the agent who can answer, and let it rest when the question has been answered.",
	},
];

/**
 * Creates any system agent the workspace does not have yet, with no model.
 *
 * Safe to repeat: an existing row is left exactly as it is, so a second call
 * never puts an administrator's chosen model back to unset.
 */
export const ensureSystemAgents = Effect.fn("SystemAgents.ensureSystemAgents")(function* (
	db: Executor,
	input: { workspaceId: string; createdById: string },
) {
	for (const definition of SYSTEM_AGENTS) {
		yield* ensureSystemAgent(db, input.workspaceId, input.createdById, definition);
	}
});

/**
 * The workspace's system agent, whether or not it has been set up.
 *
 * For reading configuration. Anything about to run a model wants
 * {@link findRunnableSystemAgent}, whose absence already means "do not run".
 */
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
 * chosen.
 *
 * Separate from {@link findSystemAgent} so a caller cannot reach a system agent
 * and forget that it may not be set up: here `undefined` is the whole answer,
 * and what comes back names a model.
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

/** Every system agent in the workspace, as the settings screens read them. */
export const listSystemAgents = Effect.fn("SystemAgents.listSystemAgents")(function* (
	db: Executor,
	workspaceId: string,
) {
	const rows = yield* db
		.select({ key: agent.systemAgentKey, model: agent.model })
		.from(agent)
		.where(and(eq(agent.workspaceId, workspaceId), isNotNull(agent.systemAgentKey)));
	const modelOf = new Map(rows.map((row) => [row.key, row.model]));
	// Driven by the definitions rather than by the rows, so the name, the face
	// and the order come from the product and only the model comes from the
	// database. A workspace missing a row reads as one that is not set up.
	return SYSTEM_AGENTS.map(
		(definition): SystemAgent => ({
			key: definition.key,
			name: definition.name,
			description: definition.description,
			hue: definition.hue,
			face: definition.face,
			model: modelOf.get(definition.key) ?? null,
		}),
	);
});

const ensureSystemAgent = Effect.fn("SystemAgents.ensureSystemAgent")(function* (
	db: Executor,
	workspaceId: string,
	createdById: string,
	definition: SystemAgentDefinition,
) {
	const [created] = yield* db
		.insert(agent)
		.values({
			workspaceId,
			podId: null,
			createdById,
			name: definition.name,
			handle: handleFromName(definition.name),
			systemAgentKey: definition.key,
			description: definition.description,
			hue: definition.hue,
			face: definition.face,
			model: null,
			prompt: definition.prompt,
		})
		.onConflictDoNothing({ target: [agent.workspaceId, agent.systemAgentKey] })
		.returning({ id: agent.id });
	if (created) {
		return created.id;
	}
	const [existing] = yield* db
		.select({ id: agent.id })
		.from(agent)
		.where(and(eq(agent.workspaceId, workspaceId), eq(agent.systemAgentKey, definition.key)))
		.limit(1);
	if (!existing) {
		throw new Error(`The ${definition.key} system agent could not be created or found`);
	}
	return existing.id;
});
