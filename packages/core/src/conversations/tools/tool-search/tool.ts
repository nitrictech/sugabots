import { type Tool, tool } from "ai";
import { Option, Schema } from "effect";
import { type CatalogEntry, catalogListing, searchCatalog } from "./catalog.ts";

/** Finds connection tools for a bridged turn (see `ConnectionToolMode`). */
export const TOOL_SEARCH = "tool_search";

/** Runs a connection tool `tool_search` found, for a bridged turn. */
export const CALL_TOOL = "call_tool";

/** A JSON object; small models often send one written out as a string, which is read the same. */
const ArgumentsObject = Schema.Record(Schema.String, Schema.Unknown);

const CallToolInput = Schema.Struct({
	tool: Schema.String.check(Schema.isMinLength(1)).annotate({
		description: "The tool's full name, connection__tool, such as notes__list_notes",
	}),
	arguments: Schema.Union([ArgumentsObject, Schema.String]).annotate({
		description:
			"A JSON object of the tool's parameters, named as its input schema names them. Use {} if it takes none.",
	}),
});

/** The connection tool a `call_tool` call names, and the arguments it gives that tool. */
type BridgedCall = { tool: string; arguments: Record<string, unknown> };

/** What a `call_tool` input asks for, or nothing when it is not one. */
export function bridgedCallOf(input: unknown): BridgedCall | undefined {
	return Option.getOrUndefined(
		Option.flatMap(Schema.decodeUnknownOption(CallToolInput)(input), ({ tool, arguments: given }) =>
			Option.map(argumentsOf(given), (args) => ({ tool, arguments: args })),
		),
	);
}

function argumentsOf(
	given: Record<string, unknown> | string,
): Option.Option<Record<string, unknown>> {
	if (typeof given !== "string") return Option.some(given);
	return Schema.decodeUnknownOption(Schema.fromJsonString(ArgumentsObject))(given);
}

/** Searches `catalog` for the tools a task needs. */
export function toolSearchTool({ catalog }: { catalog: readonly CatalogEntry[] }) {
	return tool({
		description: `Find tools from this pod's connections. Give a few words for what you want to do, a connection's name, or a tool's full name. You get the best matches, each with its full name and what it does; the best ones also have their input schema. Then run one with ${CALL_TOOL}. If nothing matches, try other words, such as the action or the thing it acts on, before telling the person a connection can't do it.`,
		inputSchema: Schema.Struct({
			query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
				description: "What you want to do, such as 'list open issues', or a tool's full name",
			}),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: ({ query }) => foundFor(catalog, query),
	});
}

/** What a search tells the model: the tools found, and what to do when that is not enough. */
function foundFor(catalog: readonly CatalogEntry[], query: string) {
	const tools = searchCatalog(catalog, query);
	if (tools.length === 0) {
		return {
			tools,
			note: "No tool matched. Try other words: the action, such as list, create or run, or the thing it acts on. Or search a connection's name to see its tools. The connections:",
			connections: catalogListing(catalog),
		};
	}
	if (tools.some((found) => !("inputSchema" in found))) {
		return {
			tools,
			note: "Search for a tool's full name to get its input schema before calling it.",
		};
	}
	return { tools };
}

/**
 * Runs the connection tool a call names. `connectionTools` holds each tool
 * as the turn would offer it directly, recording and approval included, so a
 * call through the bridge is recorded and approved as the tool it names. Like
 * a direct call, its arguments are left to the server to check.
 */
export function callToolTool({
	catalog,
	connectionTools,
}: {
	catalog: readonly CatalogEntry[];
	connectionTools: Readonly<Record<string, Tool>>;
}) {
	return tool({
		description: `Run a tool from this pod's connections by its full name, connection__tool. Pass arguments that match its input schema; if you haven't seen the schema, get it with ${TOOL_SEARCH} first. If the tool says its input is wrong, fix the arguments and call it again.`,
		inputSchema: CallToolInput.pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async (input, options) => {
			const call = bridgedCallOf(input);
			if (!call) {
				return {
					status: "failed",
					error: "The arguments must be a JSON object, such as {} for a tool that takes none.",
				};
			}
			const target = Object.hasOwn(connectionTools, call.tool)
				? connectionTools[call.tool]
				: undefined;
			if (!target?.execute) {
				return {
					status: "failed",
					error: `No connection tool is called ${call.tool}. These are the closest; call one by its full name.`,
					tools: searchCatalog(catalog, call.tool),
				};
			}
			return target.execute(call.arguments, options);
		},
	});
}
