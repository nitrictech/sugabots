import { Schema } from "effect";
import { sessionUserSchema } from "./api.ts";
import { workspaceSchema } from "./membership.ts";

/**
 * Who the caller is and their workspaces: what the web app needs before it can
 * draw anything, in one answer rather than two requests, the second of which
 * would wait for the first to say they are signed in.
 */
export const meSchema = Schema.Struct({
	user: sessionUserSchema,
	workspaces: Schema.Array(workspaceSchema),
});

export type Me = typeof meSchema.Type;
