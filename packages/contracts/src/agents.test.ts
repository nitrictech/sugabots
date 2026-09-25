import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { agentHueSchema, agentUpdateSchema, newAgentSchema } from "./agents.ts";

const ID = "0199a3a0-0000-7000-8000-000000000001";
const request = { podId: ID, name: "Issue triager", model: "example/model" };

describe("agent request contracts", () => {
	it("rejects duplicate request array values", () => {
		expect(
			Result.isSuccess(
				Schema.decodeResult(newAgentSchema)({
					...request,
					disabledTools: ["web_search", "web_search"],
				}),
			),
		).toBe(false);
	});

	it("bounds tool keys and request array lengths", () => {
		expect(
			Result.isSuccess(Schema.decodeResult(newAgentSchema)({ ...request, disabledTools: [""] })),
		).toBe(false);
		expect(
			Result.isSuccess(
				Schema.decodeResult(newAgentSchema)({ ...request, disabledTools: ["x".repeat(65)] }),
			),
		).toBe(false);
		expect(
			Result.isSuccess(
				Schema.decodeResult(newAgentSchema)({
					...request,
					disabledTools: Array.from({ length: 33 }, (_, index) => `tool-${index}`),
				}),
			),
		).toBe(false);
	});

	it.each(["anthropic/claude-sonnet", "openai:gpt-5", "local.model-v1"])(
		"accepts provider-independent model id %s",
		(model) => {
			expect(Result.isSuccess(Schema.decodeResult(newAgentSchema)({ ...request, model }))).toBe(
				true,
			);
		},
	);

	it("trims before checking lengths and tool uniqueness", () => {
		expect(
			Schema.decodeUnknownSync(newAgentSchema)({
				...request,
				name: `  ${"x".repeat(64)}  `,
				disabledTools: [" web_search "],
				extra: true,
			}),
		).toEqual({ ...request, name: "x".repeat(64), disabledTools: ["web_search"] });
		for (const fields of [
			{ name: "  " },
			{ disabledTools: ["  "] },
			{ disabledTools: ["web_search", " web_search "] },
		]) {
			expect(Result.isFailure(Schema.decodeResult(newAgentSchema)({ ...request, ...fields }))).toBe(
				true,
			);
		}
	});

	it("makes updates shallow partials and strips pod placement", () => {
		expect(Schema.decodeUnknownSync(agentUpdateSchema)({ podId: ID, extra: true })).toEqual({});
		expect(Schema.decodeSync(agentUpdateSchema)({ name: "  Renamed  " })).toEqual({
			name: "Renamed",
		});
		expect(Result.isFailure(Schema.decodeResult(agentUpdateSchema)({ model: " " }))).toBe(true);
	});

	it.each([NaN, Infinity, -Infinity, -1, 360, 1.5, "120"])("rejects invalid hue %s", (hue) => {
		expect(Result.isFailure(Schema.decodeUnknownResult(agentHueSchema)(hue))).toBe(true);
	});

	it.each([0, 359])("accepts boundary hue %s", (hue) => {
		expect(Schema.decodeSync(agentHueSchema)(hue)).toBe(hue);
	});
});
