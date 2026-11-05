import { describe, expect, it } from "vitest";
import committed from "../../openapi.json" with { type: "json" };
import { podSchema } from "../pods.ts";
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

	it("leaves the schemas it names as they were", () => {
		openApiDocument();
		expect(podSchema.ast.annotations?.identifier).toBeUndefined();
	});
});
