import { asSchema, executeTool, safeValidateTypes } from "@ai-sdk/provider-utils";
import type { ToolSet } from "ai";
import { Effect } from "effect";
import type { Toolbox } from "../../devices/device-links.ts";

/** For each tool that may ask somebody first, whether a call with this input would. */
export type AsksFirst = Record<
	string,
	(input: unknown) => "user-approval" | "not-applicable" | undefined
>;

/**
 * The turn's tools as a lent agent reaches them through its device: each
 * validated and run as the model's calls are, and so recorded on the reply.
 * A call that would wait for somebody's approval is refused instead: the
 * agent's run is live on the device, and the turn can't suspend under it.
 */
export const deviceToolbox = ({
	tools,
	asksFirst,
	callIdPrefix,
}: {
	tools: ToolSet;
	asksFirst: AsksFirst;
	/** Makes each call's id unique to the turn. */
	callIdPrefix: string;
}) =>
	Effect.promise(async (): Promise<Toolbox> => {
		const listed = await Promise.all(
			Object.entries(tools).map(async ([name, tool]) => ({
				name,
				description: typeof tool.description === "string" ? tool.description : "",
				inputSchema: await asSchema(tool.inputSchema).jsonSchema,
			})),
		);
		let calls = 0;
		return {
			list: () => listed,
			call: async (name, input, signal) => {
				const tool = tools[name];
				if (!tool?.execute) return failed(`There is no tool called ${name}.`);
				if (asksFirst[name]?.(input) === "user-approval") {
					return failed(
						"That call needs somebody in the thread to approve it, which bots on a computer can't wait for yet.",
					);
				}
				const valid = await safeValidateTypes({ value: input, schema: tool.inputSchema });
				if (!valid.success)
					return failed(`That input doesn't fit the tool: ${valid.error.message}`);
				let output: unknown;
				for await (const part of executeTool({
					tool: { ...tool, execute: tool.execute },
					input: valid.value,
					options: {
						toolCallId: `${callIdPrefix}:${++calls}`,
						messages: [],
						abortSignal: signal,
						// Sugabots' tools take no runtime context; the set's type can't say so.
						context: undefined as never,
					},
				})) {
					if (part.type === "final") output = part.output;
				}
				return {
					text: typeof output === "string" ? output : JSON.stringify(output),
					isError: false,
				};
			},
		};
	});

function failed(text: string) {
	return { text, isError: true };
}
