/**
 * Writes each app's API client from `packages/contracts/openapi.json`: a type
 * for each schema the API names, and a typed request for each route, grouped as
 * the web's client groups them.
 *
 * - iOS: `Sugabots/API/API.generated.swift`, written by `api/swift.ts`.
 *
 * `api/model.ts` reads the document into a model no one language owns, and
 * settles there what Effect's OpenAPI means; each emitter only writes it out.
 */
import document from "../../../packages/contracts/openapi.json" with { type: "json" };
import { type ApiModel, type OpenApiDocument, readModel } from "./api/model.ts";
import { swiftApi } from "./api/swift.ts";
import type { Generator } from "./generated-files.ts";

export const generator: Generator<ApiModel> = {
	model: () => readModel(document as unknown as OpenApiDocument),
	emitters: {
		ios: (model) => ({ files: new Map([["Sugabots/API/API.generated.swift", swiftApi(model)]]) }),
	},
};
