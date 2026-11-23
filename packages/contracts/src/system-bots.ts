import { Schema } from "effect";
import {
	botColorSchema,
	botEyesSchema,
	botShapeSchema,
	modelIdSchema,
	systemBotKeySchema,
} from "./bots.ts";

/**
 * Compaction, the system bot, as the settings screens see it.
 *
 * A system bot belongs to the workspace rather than to anybody: there is one
 * of each, and every bot is served by it. That is why it has a shape of its
 * own instead of travelling as a `Bot`: nobody creates, pins or talks to
 * it, which the rest of the product would otherwise have to represent.
 *
 * It is addressed by `key`, not by id. There is exactly one of each per
 * workspace, so the key is the address, and a route keyed by it cannot be
 * pointed at a bot people talk to by mistake.
 */
export const systemBotSchema = Schema.Struct({
	key: systemBotKeySchema,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	color: botColorSchema,
	eyes: botEyesSchema,
	shape: botShapeSchema,
	/**
	 * The model it runs on. `null` only while the workspace offers no model at
	 * all. The first model the workspace offers becomes this one, and it cannot
	 * be cleared after that.
	 */
	model: Schema.NullOr(modelIdSchema),
});

export type SystemBot = typeof systemBotSchema.Type;

/**
 * Choosing the model a system bot runs on, which is the only thing about one
 * that anybody may change. There is no turning one off: the product relies on
 * each of them running.
 */
export const systemBotUpdateSchema = Schema.Struct({
	model: modelIdSchema,
});
