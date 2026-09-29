import { Schema } from "effect";
import {
	agentColorSchema,
	agentFaceSchema,
	modelIdSchema,
	systemAgentKeySchema,
} from "./agents.ts";

/**
 * The Scribe and the Facilitator as the settings screens see them.
 *
 * A system agent belongs to the workspace rather than to a pod: there is one of
 * each, and every pod is served by it. That is why it has a shape of its own
 * instead of travelling as an `Agent` with the pod left out — an `Agent` that
 * belongs to no pod is not something the rest of the product has to represent.
 *
 * It is addressed by `key`, not by id. There is exactly one of each per
 * workspace, so the key is the address, and a route keyed by it cannot be
 * pointed at a crew agent by mistake.
 */
export const systemAgentSchema = Schema.Struct({
	key: systemAgentKeySchema,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	color: agentColorSchema,
	face: agentFaceSchema,
	/**
	 * The model it runs on. `null` only while the workspace offers no model at
	 * all, and until then the agent does not run: no summaries are written, and
	 * no pod may hand the Facilitator the floor. The first model the workspace
	 * offers becomes this one, and it cannot be cleared after that.
	 */
	model: Schema.NullOr(modelIdSchema),
});

export type SystemAgent = typeof systemAgentSchema.Type;

/**
 * Choosing the model a system agent runs on, which is the only thing about one
 * that anybody may change. There is no turning one off: the product relies on
 * each of them running.
 */
export const systemAgentUpdateSchema = Schema.Struct({
	model: modelIdSchema,
});

export type SystemAgentUpdate = typeof systemAgentUpdateSchema.Type;
