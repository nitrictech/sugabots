import { automationsContracts } from "@sugabots/contracts/operations/automations";
import { filesContracts } from "@sugabots/contracts/operations/files";
import { webContracts } from "@sugabots/contracts/operations/web";
import { asSchema } from "ai";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

const fetchInput = webContracts["web.fetch"].input.pipe(
	Schema.toStandardSchemaV1,
	Schema.toStandardJSONSchemaV1,
);
const searchInput = webContracts["web.search"].input.pipe(
	Schema.toStandardSchemaV1,
	Schema.toStandardJSONSchemaV1,
);

describe("native Effect tool schemas through the AI SDK", () => {
	it.each([
		{
			schema: fetchInput,
			valid: { url: "https://example.com" },
			invalid: { url: "" },
		},
	])("validates tool input without executing it ($valid)", async ({ schema, valid, invalid }) => {
		const sdkSchema = asSchema<unknown>(schema);
		expect(await sdkSchema.validate?.(valid)).toEqual({ success: true, value: valid });
		expect(await sdkSchema.validate?.(invalid)).toMatchObject({ success: false });
	});

	it("emits field descriptions and bounds for untransformed inputs", async () => {
		expect(await asSchema(fetchInput).jsonSchema).toMatchObject({
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

	it("exposes the search input bounds and defaults to model providers", async () => {
		const schema = asSchema(searchInput);
		expect(await schema.jsonSchema).toMatchObject({
			type: "object",
			properties: {
				query: { type: "string", minLength: 1, maxLength: 400 },
				count: { type: "integer", minimum: 1, maximum: 10, default: 5 },
			},
			required: ["query"],
			additionalProperties: false,
		});
		expect(await schema.validate?.({ query: "x", count: 0 })).toMatchObject({ success: false });
	});

	it.each([
		"automations.listInChat",
		"automations.createWithRoutine",
		"automations.updateInChat",
	] as const)("gives %s an object input schema, as providers require", async (name) => {
		const input = automationsContracts[name].input.pipe(
			Schema.toStandardSchemaV1,
			Schema.toStandardJSONSchemaV1,
		);
		expect(await asSchema(input).jsonSchema).toMatchObject({ type: "object" });
	});

	it.each([
		...Object.values(filesContracts).map(
			({ name, input }) =>
				[
					name,
					{ inputSchema: input.pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1) },
				] as const,
		),
	])("gives %s an object input schema, as providers require", async (_name, builtInTool) => {
		expect(await asSchema(builtInTool.inputSchema).jsonSchema).toMatchObject({ type: "object" });
	});
});
