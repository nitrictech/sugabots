import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { botColorSchema, botUpdateSchema, newBotSchema } from "./bots.ts";

const request = { name: "Issue triager", model: "example/model" };

describe("bot request contracts", () => {
	it("rejects duplicate request array values", () => {
		expect(
			Result.isSuccess(
				Schema.decodeResult(newBotSchema)({
					...request,
					disabledTools: ["web_search", "web_search"],
				}),
			),
		).toBe(false);
	});

	it("bounds tool keys and request array lengths", () => {
		expect(
			Result.isSuccess(Schema.decodeResult(newBotSchema)({ ...request, disabledTools: [""] })),
		).toBe(false);
		expect(
			Result.isSuccess(
				Schema.decodeResult(newBotSchema)({ ...request, disabledTools: ["x".repeat(65)] }),
			),
		).toBe(false);
		expect(
			Result.isSuccess(
				Schema.decodeResult(newBotSchema)({
					...request,
					disabledTools: Array.from({ length: 33 }, (_, index) => `tool-${index}`),
				}),
			),
		).toBe(false);
	});

	it.each(["anthropic/claude-sonnet", "openai:gpt-5", "local.model-v1"])(
		"accepts provider-independent model id %s",
		(model) => {
			expect(Result.isSuccess(Schema.decodeResult(newBotSchema)({ ...request, model }))).toBe(true);
		},
	);

	it("trims before checking lengths and tool uniqueness", () => {
		expect(
			Schema.decodeUnknownSync(newBotSchema)({
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
			expect(Result.isFailure(Schema.decodeResult(newBotSchema)({ ...request, ...fields }))).toBe(
				true,
			);
		}
	});

	it("makes updates shallow partials and strips channel placement", () => {
		expect(Schema.decodeUnknownSync(botUpdateSchema)({ extra: true })).toEqual({});
		expect(Schema.decodeSync(botUpdateSchema)({ name: "  Renamed  " })).toEqual({
			name: "Renamed",
		});
		expect(Result.isFailure(Schema.decodeResult(botUpdateSchema)({ model: " " }))).toBe(true);
	});

	it.each(["blue", "", 120, "Green"])("rejects a colour outside the palette: %s", (color) => {
		expect(Result.isFailure(Schema.decodeUnknownResult(botColorSchema)(color))).toBe(true);
	});
});
