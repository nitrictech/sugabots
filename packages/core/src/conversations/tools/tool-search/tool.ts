import { type Tool, tool } from "ai";
import { Option, Schema } from "effect";
import { type CatalogEntry, connectionsOf, searchCatalog } from "./catalog.ts";

/**
 * The tools a bridged turn offers in place of its pod's connection tools
 * (see `ConnectionToolMode`): one finds them, the other runs them.
 */
export const TOOL_SEARCH = "tool_search";
export const CALL_TOOL = "call_tool";

const CallToolInput = Schema.Struct({
	tool: Schema.String.check(Schema.isMinLength(1)).annotate({
		description: "The tool's full name as tool_search gave it, such as linear__list_issues",
	}),
	arguments: Schema.Record(Schema.String, Schema.Unknown).annotate({
		description: "The tool's input, matching the input schema tool_search gave for it",
	}),
});

/** The connection tool a `call_tool` call names, and the input it gives that tool. */
export interface BridgedCall {
	tool: string;
	arguments: Record<string, unknown>;
}

/**
 * What a call to `call_tool` asks for, or nothing when `input` is not a
 * call's input. Approval, running and resuming all read a bridged call
 * through this, so they agree on which tool it is for.
 */
export function bridgedCallOf(input: unknown): BridgedCall | undefined {
	return Option.getOrUndefined(Schema.decodeUnknownOption(CallToolInput)(input));
}

/** What the model is told of a call naming no tool this turn offers, in place of a result. */
interface UnknownTool {
	status: "failed";
	reason: string;
}

/** Searches `catalog` for the tools a task needs. */
export function toolSearchTool({ catalog }: { catalog: readonly CatalogEntry[] }) {
	return tool({
		description: `Find tools from this pod's connections. Describe what you want to do in a few words; you get the best matching tools, each with its full name, what it does and its input schema. Run one with ${CALL_TOOL}. If nothing matches, try other words before deciding a connection can't do it.`,
		inputSchema: Schema.Struct({
			query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
				description: "What you want to do, such as 'list open issues' or 'run a SQL query'",
			}),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: ({ query }) => {
			const tools = searchCatalog(catalog, query);
			if (tools.length > 0) return { tools };
			return {
				tools,
				note: "No tool matched those words. Try others, such as the action or the thing it acts on. These connections have tools:",
				connections: connectionsOf(catalog),
			};
		},
	});
}

/**
 * Runs the connection tool a call names. `callable` holds each tool as the
 * turn would offer it directly, recording and approval included, so a call
 * through the bridge is recorded and approved as the tool it names. Like a
 * direct call, its arguments are left to the server to check.
 */
export function callTool({ callable }: { callable: Readonly<Record<string, Tool>> }) {
	return tool({
		description: `Run a tool from this pod's connections that ${TOOL_SEARCH} found, with arguments that match its input schema.`,
		inputSchema: CallToolInput.pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async (call, options) => {
			const target = Object.hasOwn(callable, call.tool) ? callable[call.tool] : undefined;
			if (!target?.execute) {
				return {
					status: "failed",
					reason: `No connection tool is called ${call.tool}. Find one with ${TOOL_SEARCH} and use its full name.`,
				} satisfies UnknownTool;
			}
			return target.execute(call.arguments, options);
		},
	});
}
