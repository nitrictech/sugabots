import { Schema } from "effect";
import { jsonValueSchema } from "./threads.ts";

/**
 * The MCP App a tool call's output is shown in: the HTML its server gives
 * for the tool, and the origins the app says it reaches, which the frame's
 * content security policy allows and nothing else.
 */
export const mcpAppResourceSchema = Schema.Struct({
	html: Schema.String,
	csp: Schema.Struct({
		/** Origins the app may fetch from or open a socket to. */
		connectDomains: Schema.Array(Schema.String),
		/** Origins the app may load scripts, styles, images and fonts from. */
		resourceDomains: Schema.Array(Schema.String),
		/** Origins the app may frame. */
		frameDomains: Schema.Array(Schema.String),
	}),
	/** Whether the app asks to be drawn inside a border; null when it doesn't say. */
	prefersBorder: Schema.NullOr(Schema.Boolean),
});

export type McpAppResource = typeof mcpAppResourceSchema.Type;

/** A call an MCP App asks its server for, through the tool call it is shown with. */
export const mcpAppToolCallSchema = Schema.Struct({
	name: Schema.String,
	arguments: Schema.Record(Schema.String, jsonValueSchema),
});

/** The server's MCP `CallToolResult`, as it answered. */
export const mcpAppToolResultSchema = jsonValueSchema;
