/**
 * Writes openapi.json, the API as an OpenAPI document, which the native apps
 * generate their client from.
 *
 * Run with `bun run --cwd packages/contracts generate` after changing the API
 * or a schema it uses. The package's test fails until it is run.
 */
import { writeFileSync } from "node:fs";
import { openApiDocument, openApiText } from "../src/http/openapi.ts";

const document = openApiDocument();
writeFileSync(new URL("../openapi.json", import.meta.url), openApiText(document));
console.log(
	`openapi.json: ${Object.keys(document.paths).length} paths, ${Object.keys(document.components.schemas).length} schemas`,
);
