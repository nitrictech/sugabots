/**
 * Writes each app's API client from `packages/contracts/openapi.json`: a type
 * for each schema the API names, and a typed request for each route, grouped as
 * the web's client groups them.
 *
 * - Android: `api/src/main/kotlin/ai/sugabots/api/Api.generated.kt`, written by
 *   `api/kotlin.ts`.
 *
 * `api/model.ts` reads the document into a model no one language owns, and
 * settles there what Effect's OpenAPI means and what every type, field and
 * case is called; each emitter only spells that model in its language.
 */
import document from "../../packages/contracts/openapi.json" with { type: "json" };
import { kotlinApi } from "./api/kotlin.ts";
import { type OpenApiDocument, readModel } from "./api/model.ts";
import type { Generator } from "./generated-files.ts";

export const generator: Generator = {
	targets: ["android"],
	generate(target) {
		const model = readModel(document as unknown as OpenApiDocument);
		switch (target) {
			case "android":
				return {
					files: new Map([
						["api/src/main/kotlin/ai/sugabots/api/Api.generated.kt", kotlinApi(model)],
					]),
				};
		}
	},
};
