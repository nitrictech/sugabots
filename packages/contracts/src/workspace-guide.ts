import { Schema } from "effect";
import { uuidSchema } from "./uuid.ts";

/**
 * How many automations are failing in one place the member reaches: a bot's
 * own, named by the bot, or a project's, named by the project.
 */
const failingAutomationsSchema = Schema.Union([
	Schema.Struct({ bot: Schema.String, failing: Schema.Number, link: Schema.String }),
	Schema.Struct({ project: Schema.String, failing: Schema.Number, link: Schema.String }),
]);

/**
 * A Personal Assistant's view of its member's workspace: its projects, the
 * bots they reach with what each is for, and what is waiting on them, each
 * with its link and the ids the assistant acts on them by.
 */
export const workspaceGuideSchema = Schema.Struct({
	workspaceId: uuidSchema,
	projects: Schema.Array(
		Schema.Struct({
			id: uuidSchema,
			name: Schema.String,
			address: Schema.String,
			link: Schema.String,
			description: Schema.NullOr(Schema.String),
			private: Schema.Boolean,
			youAreIn: Schema.Boolean,
			/** The lead bot's handle. */
			lead: Schema.String,
		}),
	),
	bots: Schema.Array(
		Schema.Struct({
			id: uuidSchema,
			name: Schema.String,
			handle: Schema.String,
			link: Schema.String,
			description: Schema.NullOr(Schema.String),
			personal: Schema.Boolean,
			pinned: Schema.Boolean,
		}),
	),
	waitingOnYou: Schema.Struct({
		approvals: Schema.Array(
			Schema.Struct({ bot: Schema.String, tool: Schema.String, link: Schema.String }),
		),
		unreadMentions: Schema.Array(
			Schema.Struct({ from: Schema.String, preview: Schema.String, link: Schema.String }),
		),
		failingAutomations: Schema.Array(failingAutomationsSchema),
	}),
});

export type WorkspaceGuide = typeof workspaceGuideSchema.Type;
