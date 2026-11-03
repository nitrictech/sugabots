import { describe, expect, it } from "vitest";
import committed from "../../openapi.json" with { type: "json" };
import { openApiDocument } from "./openapi.ts";

describe("openapi.json", () => {
	it("is generated from the API (run `bun run --cwd packages/contracts generate`)", () => {
		expect(committed).toEqual(openApiDocument());
	});

	it("names each exported schema it uses, and refers to it rather than repeating it", () => {
		const document = openApiDocument();
		expect(document.components.schemas.Pod).toBeDefined();
		expect(JSON.stringify(document.paths)).toContain('"$ref":"#/components/schemas/Pod"');
	});
});
