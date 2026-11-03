import { Schema } from "effect";
import { OpenApi } from "effect/unstable/httpapi";
import * as contracts from "../index.ts";
import { Api } from "./api.ts";

/**
 * The API as an OpenAPI 3.1 document, for clients that can't import these
 * schemas: the native apps generate their models and requests from it.
 *
 * Effect writes a schema inline unless it has an `identifier`, so the same pod
 * would reach a client as a dozen anonymous shapes. Rather than repeat each
 * schema's name at its definition, every schema this package exports as
 * `fooSchema` is named `Foo` here, and written once as that component wherever
 * the API uses it. A schema exported under a new name is named without
 * anything else to update.
 *
 * The live-update events are added as components too, since their routes
 * answer with a stream the document can't describe.
 */
export function openApiDocument(): OpenApi.OpenAPISpec {
	const exported = nameExportedSchemas();
	const document = OpenApi.fromApi(Api);
	const named = new NamedSchemas(namedByShape(exported, document.components.schemas));
	const paths = named.refer(document.paths as Json) as OpenApi.OpenAPISpec["paths"];
	const components = named.refer(document.components.schemas as Json) as Record<string, JsonObject>;
	for (const [name, schema] of Object.entries(eventComponents())) {
		components[name] = named.refer(schema as Json) as JsonObject;
	}
	return {
		...document,
		info: { ...document.info, title: "Sugabots" },
		paths,
		components: {
			...document.components,
			schemas: sortedByKey({ ...components, ...named.components }),
		},
	};
}

/** The document as `openapi.json` holds it. */
export function openApiText(document: OpenApi.OpenAPISpec): string {
	return `${JSON.stringify(document, null, "\t")}\n`;
}

/** What each live-update stream can carry, by the component name it's written under. */
const streamedEventSchemas = {
	ThreadUpdateEvent: contracts.threadUpdateEventSchema,
	WorkspaceUpdateEvent: contracts.workspaceUpdateEventSchema,
	PersonUpdateEvent: contracts.personUpdateEventSchema,
} satisfies Record<string, Schema.Top>;

/**
 * Gives each exported schema the `identifier` Effect names it by: `podSchema`
 * is `Pod`. Effect reads it from the schema's AST, where it's set in place, so
 * the API, which holds these same schemas, is named without being rebuilt. A
 * schema exported under two names keeps the first, alphabetically.
 */
function nameExportedSchemas(): Map<string, Schema.Top> {
	const named = new Map<string, Schema.Top>();
	const exports = Object.entries(contracts).sort(([a], [b]) => a.localeCompare(b));
	for (const [exportName, value] of exports) {
		if (!exportName.endsWith("Schema") || !Schema.isSchema(value)) continue;
		const ast = value.ast as { annotations?: Record<string, unknown> };
		const identifier = ast.annotations?.identifier;
		if (typeof identifier === "string") {
			if (!named.has(identifier)) named.set(identifier, value);
			continue;
		}
		const name = componentName(exportName);
		ast.annotations = { ...ast.annotations, identifier: name };
		named.set(name, value);
	}
	return named;
}

/**
 * The exported schemas to name by their shape where Effect wrote them inline.
 * Effect rebuilds a schema that holds arbitrary JSON, such as a tool call's
 * input, to encode it, and one a route gives its own status, and the rebuilt
 * schema loses its name. A schema Effect did name is matched by shape only if
 * it's distinctive enough that another of that shape is surely the same thing.
 */
function namedByShape(exported: Map<string, Schema.Top>, components: Record<string, unknown>) {
	const schemas = new Map<string, JsonObject>();
	for (const [name, schema] of exported) {
		const json = jsonSchemaOf(schema);
		if (!isWorthNaming(json)) continue;
		if (name in components && !isDistinctive(json)) continue;
		schemas.set(name, json);
	}
	return schemas;
}

/**
 * Whether a schema's shape is particular enough that a match is no coincidence:
 * a union, or an object with three fields or more, or one that holds a named
 * schema. A lone `url` field could be anything's.
 */
function isDistinctive(schema: JsonObject): boolean {
	if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) return true;
	const properties =
		typeof schema.properties === "object" && schema.properties !== null
			? Object.values(schema.properties)
			: [];
	return properties.length >= 3 || JSON.stringify(properties).includes('"$ref"');
}

/** A schema's JSON Schema, written as `OpenApi.fromApi` writes bodies, the schemas it uses referred to by name. */
function jsonSchemaOf(schema: Schema.Top): JsonObject {
	const document = Schema.toJsonSchemaDocument(Schema.toCodecJson(schema), {
		onExcessProperty: "error",
	});
	const top = document.schema as JsonObject;
	const definitions = document.definitions as Record<string, JsonObject>;
	// A named schema's document only refers to it among its definitions.
	const reference = typeof top.$ref === "string" ? top.$ref.replace("#/$defs/", "") : undefined;
	return asComponentReferences((reference && definitions[reference]) || top);
}

/** Objects, unions and enums get names; a bare string or number is clearer written in place. */
function isWorthNaming(schema: JsonObject): boolean {
	if (schema.type === "object" && schema.properties) return true;
	if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) return true;
	return Array.isArray(schema.enum) && schema.enum.length > 1;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Words that describe a schema rather than shape it, so two uses of one schema still match when only these differ. */
const descriptiveKeys = new Set(["description", "title", "examples", "default"]);

/** A schema's shape as a string, the same for two schemas that accept the same JSON. */
function shapeKey(schema: Json): string {
	const visit = (value: Json): Json => {
		if (Array.isArray(value)) return value.map(visit);
		if (value === null || typeof value !== "object") return value;
		const entries = Object.entries(value)
			.filter(([key]) => !descriptiveKeys.has(key))
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, child]) => [key, visit(child)]);
		return Object.fromEntries(entries);
	};
	return JSON.stringify(visit(schema));
}

/**
 * Replaces each inline schema shaped as one of `schemas` with a reference to
 * it, and collects the components those references name.
 */
class NamedSchemas {
	readonly components: Record<string, JsonObject> = {};
	private readonly nameByShape = new Map<string, string>();
	private readonly schemaByName: Map<string, JsonObject>;

	constructor(schemas: Map<string, JsonObject>) {
		this.schemaByName = schemas;
		for (const [name, schema] of schemas) {
			const shape = shapeKey(schema as Json);
			// Two exports of one shape are aliases; the first name, alphabetically, is kept.
			if (!this.nameByShape.has(shape)) this.nameByShape.set(shape, name);
		}
	}

	/** `value` with every schema in it shaped as a named one replaced by a reference. */
	refer(value: Json): Json {
		if (Array.isArray(value)) return value.map((item) => this.refer(item));
		if (value === null || typeof value !== "object") return value;
		const name = this.nameByShape.get(shapeKey(value));
		if (name === undefined) return this.referInside(value);
		this.define(name);
		const reference: { [key: string]: Json } = { $ref: `#/components/schemas/${name}` };
		// A use can describe what it holds in its own words, beside the reference.
		if (typeof value.description === "string") reference.description = value.description;
		return reference;
	}

	private referInside(object: { [key: string]: Json }): { [key: string]: Json } {
		return Object.fromEntries(
			Object.entries(object).map(([key, child]) => [key, this.refer(child)]),
		);
	}

	private define(name: string): void {
		if (name in this.components) return;
		const schema = this.schemaByName.get(name);
		if (!schema) return;
		// Claimed before its parts are visited, so a schema that contains itself ends.
		this.components[name] = {};
		this.components[name] = this.referInside(schema as { [key: string]: Json }) as JsonObject;
	}
}

/** `podSchema` → `Pod`. */
function componentName(exportName: string): string {
	const base = exportName.slice(0, -"Schema".length);
	return base.charAt(0).toUpperCase() + base.slice(1);
}

type JsonObject = { [key: string]: unknown };

/** The event unions and the schemas they use, as components that refer to one another. */
function eventComponents(): Record<string, JsonObject> {
	const components: Record<string, JsonObject> = {};
	for (const [name, schema] of Object.entries(streamedEventSchemas)) {
		const document = Schema.toJsonSchemaDocument(Schema.toCodecJson(schema), {
			onExcessProperty: "error",
		});
		const definitions = document.definitions as Record<string, JsonObject>;
		for (const [definition, value] of Object.entries(definitions)) {
			components[definition] = asComponentReferences(value);
		}
		// Named itself, the union is among the definitions, and its document only refers to it.
		if (!(name in definitions))
			components[name] = asComponentReferences(document.schema as JsonObject);
	}
	return components;
}

/** A JSON Schema with its `#/$defs/` references pointed at the document's components. */
function asComponentReferences(schema: JsonObject): JsonObject {
	const text = JSON.stringify(schema).replaceAll('"#/$defs/', '"#/components/schemas/');
	return JSON.parse(text) as JsonObject;
}

function sortedByKey<Value>(record: Record<string, Value>): Record<string, Value> {
	return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}
