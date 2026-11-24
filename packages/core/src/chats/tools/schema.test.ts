import { asSchema, generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import {
	MAX_SEARCH_RESULTS,
	type SearchOutcome,
	type SearchRequest,
} from "../../providers/search-providers/provider-search.ts";
import { automationTools } from "./automations/tool.ts";
import { fileTools } from "./files/tool.ts";
import { webFetchTool } from "./web-fetch/tool.ts";
import { webSearchTool } from "./web-search/tool.ts";

function unexpectedExecution(): never {
	throw new Error("Schema validation must not execute the tool");
}

const SETTINGS_PAGE = "https://sugabots.example/acme/settings/search";
const fetchTool = webFetchTool({ fetchPage: unexpectedExecution });

describe("native Effect tool schemas through the AI SDK", () => {
	it.each([
		{
			schema: fetchTool.inputSchema,
			valid: { url: "https://example.com" },
			invalid: { url: "" },
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
				},
			},
			required: ["url"],
		});
	});

	it("decodes search input before AI SDK execution", async () => {
		const input = { query: "  Effect Schema  " };
		const search = vi.fn(
			async (_request: SearchRequest): Promise<SearchOutcome> => ({ ok: true, results: [] }),
		);
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
			tools: { web_search: webSearchTool({ search, settingsPageUrl: SETTINGS_PAGE }) },
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
						},
						count: {
							type: "integer",
							minimum: 1,
							maximum: MAX_SEARCH_RESULTS,
							default: 5,
						},
					},
					required: ["query"],
					additionalProperties: false,
				},
			},
		]);
	});

	it("rejects invalid search input", async () => {
		const schema = asSchema(
			webSearchTool({ search: unexpectedExecution, settingsPageUrl: SETTINGS_PAGE }).inputSchema,
		);
		expect(await schema.validate?.({ query: "x", count: 0 })).toMatchObject({ success: false });
	});

	it.each([
		...Object.entries(
			fileTools({
				by: { botId: "bot", chatId: "chat" },
				turnId: "turn",
				calls: { completedOutputs: unexpectedExecution },
				authoring: {
					list: unexpectedExecution,
					read: unexpectedExecution,
					create: unexpectedExecution,
					replace: unexpectedExecution,
					edit: unexpectedExecution,
				},
				run: unexpectedExecution,
			}),
		),
		...Object.entries(
			automationTools({
				bot: { botId: "bot", projectId: "project", askerId: "member" },
				timeZone: "UTC",
				automations: {
					list: unexpectedExecution,
					create: unexpectedExecution,
					update: unexpectedExecution,
				},
				run: unexpectedExecution,
			}),
		),
	])("gives %s an object input schema, as providers require", async (_name, builtInTool) => {
		expect(await asSchema(builtInTool.inputSchema).jsonSchema).toMatchObject({ type: "object" });
	});
});
