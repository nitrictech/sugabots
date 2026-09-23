import { Schema, Struct } from "effect";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * Agents: a configured model with a name, a face and a prompt.
 *
 * An agent belongs to exactly one pod. It is created from that pod and cannot
 * be detached or moved independently.
 */

/**
 * An agent's colour, as a hue. One number, not a palette: the avatar and the
 * name are two lightnesses of it. See the `agent-tint` utility in the web app.
 */
export const agentHueSchema = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 359 }));

/**
 * Which face is knocked out of that colour. Geometry rather than an upload, so
 * an agent created at run time has an avatar without anybody drawing one.
 */
export const agentFaceSchema = Schema.Literals(["bar", "smile", "dots", "square"]);

export type AgentFace = typeof agentFaceSchema.Type;

/**
 * An upstream model id. Provider configuration is the authority on whether it
 * may be selected; this only rejects values that cannot be sent safely.
 */
export const modelIdSchema = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
	Schema.isPattern(/^[\w./:-]+$/, {
		message: "A model id may contain letters, numbers, dots, slashes, colons and dashes",
	}),
);

/**
 * How an agent is addressed in a message: `@personal-assistant`. Lower case,
 * so that a mention typed by hand matches, and unique within the workspace.
 */
export const handleSchema = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(48),
	Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
		message: "Lower case letters, numbers and single hyphens",
	}),
);

/** The handle an agent or person gets from their name: `Personal Assistant` becomes `personal-assistant`. */
export function handleFromName(name: string): string {
	return (
		name
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48)
			.replace(/-+$/g, "") || "agent"
	);
}

/**
 * The system agents the product ships: agents the system calls rather than ones a
 * workspace writes. One of each per workspace, serving every pod in it.
 *
 * The keys live here so the API, the settings screens and a model trial all
 * name the same system agent, and adding one is a compile error everywhere it has
 * to be handled rather than a string to remember.
 */
export const systemAgentKeySchema = Schema.Literals(["summarise", "facilitate"]);
export type SystemAgentKey = typeof systemAgentKeySchema.Type;

export const agentSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	podId: uuidSchema,
	name: Schema.String,
	handle: handleSchema,
	/**
	 * Which system role this agent performs, or null for crew.
	 *
	 * Always null in practice: this is the shape of an agent in a pod, and a
	 * system agent belongs to the workspace instead (`systemAgentSchema`). The
	 * field stays because a client still sorts and filters on it.
	 */
	systemAgentKey: Schema.NullOr(systemAgentKeySchema),
	description: Schema.NullOr(Schema.String),
	hue: agentHueSchema,
	face: agentFaceSchema,
	/**
	 * Which model answers. `null` when nobody has chosen one, or somebody has
	 * cleared it — the agent's turns then refuse rather than run on a guess.
	 */
	model: Schema.NullOr(modelIdSchema),
	/** The system prompt. Empty until somebody writes one. */
	prompt: Schema.String,
	/**
	 * The built-in tools switched off for this agent, by key. A list of what is
	 * off rather than what is on, so a new built-in tool reaches every existing
	 * agent (ADR 005). Empty for an agent with everything.
	 */
	disabledTools: Schema.mutable(Schema.Array(Schema.String)),
	createdAt: isoTimestampSchema,
});

export type Agent = typeof agentSchema.Type;

const nameSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64));
const toolKeysSchema = Schema.mutable(
	Schema.Array(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
).check(Schema.isMaxLength(32), Schema.isUnique({ message: "Tool keys must be unique" }));

/** How long a prompt may be. The settings page counts against it as you type. */
export const PROMPT_MAX_LENGTH = 20_000;

export const newAgentInPodSchema = Schema.Struct({
	name: nameSchema,
	/** Derived from the name when left out. */
	handle: Schema.optional(handleSchema),
	description: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(280)))),
	hue: Schema.optional(agentHueSchema),
	face: Schema.optional(agentFaceSchema),
	model: modelIdSchema,
	prompt: Schema.optional(Schema.String.check(Schema.isMaxLength(PROMPT_MAX_LENGTH))),
	disabledTools: Schema.optional(toolKeysSchema),
});

export const newAgentSchema = newAgentInPodSchema.mapFields(Struct.assign({ podId: uuidSchema }));

export type NewAgent = typeof newAgentSchema.Type;
export type NewAgentInPod = typeof newAgentInPodSchema.Type;

/**
 * Everything an administrator may change. Pod ownership is immutable.
 */
export const agentUpdateSchema = newAgentSchema
	.mapFields(Struct.omit(["podId"]))
	.mapFields(Struct.map(Schema.optional))
	// A model may be cleared, which creation has no use for: an agent is made
	// with one, and stops having one only when somebody takes it away.
	.mapFields(Struct.assign({ model: Schema.optional(Schema.NullOr(modelIdSchema)) }));

export type AgentUpdate = typeof agentUpdateSchema.Type;
