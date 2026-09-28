import { asSchema, generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import {
	MAX_SEARCH_RESULTS,
	type SearchBackend,
} from "../../providers/search-providers/backends.ts";
import { collaborateTool } from "./collaborate/tool.ts";
import { webFetchTool } from "./web-fetch/tool.ts";
import { webSearchTool } from "./web-search/tool.ts";

function unexpectedExecution(): never {
	throw new Error("Schema validation must not execute the tool");
}

const fetchTool = webFetchTool({ fetchPage: unexpectedExecution });
const collaborate = collaborateTool({
	from: { threadId: "thread", agentId: "agent", turnId: "turn", messageId: "message" },
	collaborations: { open: unexpectedExecution, collectAnswer: unexpectedExecution },
	bus: { subscribe: unexpectedExecution },
	run: unexpectedExecution,
	replyLength: unexpectedExecution,
	noteCollaboration: unexpectedExecution,
	signal: new AbortController().signal,
});

describe("native Effect tool schemas through the AI SDK", () => {
	it.each([
		{
			schema: fetchTool.inputSchema,
			valid: { url: "https://example.com" },
			invalid: { url: "" },
		},
		{
			schema: collaborate.inputSchema,
			valid: { to: "Helper", brief: "Look" },
			invalid: { to: "Helper", brief: "" },
		},
	])("validates tool input without executing it ($valid)", async ({ schema, valid, invalid }) => {
		const sdkSchema = asSchema<unknown>(schema);
		expect(await sdkSchema.validate?.(valid)).toEqual({ success: true, value: valid });
		expect(await sdkSchema.validate?.(invalid)).toMatchObject({ success: false });
	});

	it("emits field descriptions and bounds for untransformed inputs", async () => {
		expect(await asSchema(fetchTool.inputSchema).jsonSchema).toMatchObject({
			properties: {
				url: {
					type: "string",
					minLength: 1,
					maxLength: 2_048,
					description: "The full http or https address of the page",
				},
			},
			required: ["url"],
		});
		expect(await asSchema(collaborate.inputSchema).jsonSchema).toMatchObject({
			properties: {
				to: { type: "string", description: "The other agent's name, exactly as listed" },
				brief: {
					type: "string",
					minLength: 1,
					maxLength: 20_000,
					description: "What you need from them, with all the context they need",
				},
			},
			required: ["to", "brief"],
		});
	});

	it("decodes search input before AI SDK execution", async () => {
		const input = { query: "  Effect Schema  " };
		const search = vi.fn<SearchBackend>(async () => ({ ok: true, results: [] }));
		const model = new MockLanguageModelV4({
			doGenerate: {
				content: [
					{
						type: "tool-call",
						toolCallId: "search-1",
						toolName: "web_search",
						input: JSON.stringify(input),
					},
				],
				finishReason: { unified: "tool-calls", raw: undefined },
				usage: {
					inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				},
				warnings: [],
			},
		});
		await generateText({
			model,
			prompt: "Search",
			tools: { web_search: webSearchTool({ search }) },
		});
		expect(search).toHaveBeenCalledExactlyOnceWith({
			query: "Effect Schema",
			count: 5,
			signal: undefined,
		});
		expect(model.doGenerateCalls[0]?.tools).toMatchObject([
			{
				type: "function",
				name: "web_search",
				inputSchema: {
					type: "object",
					properties: {
						query: {
							type: "string",
							minLength: 1,
							maxLength: 400,
							description: "What to search for, as you would type it",
						},
						count: {
							type: "integer",
							minimum: 1,
							maximum: MAX_SEARCH_RESULTS,
							default: 5,
							description: "How many results to return",
						},
					},
					required: ["query"],
					additionalProperties: false,
				},
			},
		]);
	});

	it("rejects invalid search input", async () => {
		const schema = asSchema(webSearchTool({ search: unexpectedExecution }).inputSchema);
		expect(await schema.validate?.({ query: "x", count: 0 })).toMatchObject({ success: false });
	});
});
