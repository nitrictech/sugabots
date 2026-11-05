import { Schema, type SchemaAST } from "effect";
import { HttpApi, OpenApi } from "effect/unstable/httpapi";
import * as contracts from "../index.ts";
import { Api } from "./api.ts";

/**
 * The API as an OpenAPI 3.1 document, for clients that can't import these
 * schemas: the native apps generate their models and requests from it.
 *
 * Effect writes a schema inline unless it's given a name, so the same pod
 * would reach a client as a dozen anonymous shapes. Rather than repeat each
 * schema's name at its definition, every object, union and array schema this
 * package exports as `fooSchema` is named `Foo` here, and written once as that
 * component wherever the API uses it. A schema exported under a new name is
 * named without anything else to update.
 *
 * A route that gives a schema its own status uses a copy of it. When the
 * schema holds a transformation, such as a trimmed string or arbitrary JSON,
 * Effect rebuilds the copy to write it, and only an `identifier` given at the
 * schema's definition reaches the rebuilt copy.
 *
 * The live-update events are added as components too, since their routes
 * answer with a stream the document can't describe.
 */
export function openApiDocument(): OpenApi.OpenAPISpec {
	const exportedSchemaName = exportedSchemaNames();
	const api = Api.annotate(
		HttpApi.AdditionalSchemas,
		Object.entries(streamedEventSchemas).map(([name, schema]) =>
			schema.annotate({ identifier: name }),
		),
	);
	const document = withoutNumberedCopies(
		OpenApi.fromApi(api, {
			referencePolicy: ({ ast, identifier }) => exportedSchemaName(ast) ?? identifier,
		}),
	);
	return {
		...document,
		info: { ...document.info, title: "Sugabots" },
		components: { ...document.components, schemas: sortedByKey(document.components.schemas) },
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
 * Returns a function that gives the component name of the exported schema an
 * AST belongs to, or `undefined` for an AST of no exported schema. An AST
 * belongs to a schema when it is the schema's own, an annotated copy of it, or
 * the AST Effect writes either as JSON. A schema exported under two names
 * keeps the first, alphabetically.
 *
 * Throws when two different exported schemas would share a name.
 */
function exportedSchemaNames(): (ast: SchemaAST.AST) => string | undefined {
	const nameByContents = new Map<ReadonlyArray<unknown>, string>();
	const add = (ast: SchemaAST.AST, name: string) => {
		const contents = contentsOf(ast);
		if (contents !== undefined && !nameByContents.has(contents)) {
			nameByContents.set(contents, name);
		}
	};

	const schemaByName = new Map<string, Schema.Top>();
	const exports = Object.entries(contracts).sort(([a], [b]) => a.localeCompare(b));
	for (const [exportName, value] of exports) {
		if (!exportName.endsWith("Schema") || !Schema.isSchema(value)) continue;
		const identifier = value.ast.annotations?.identifier;
		const name = typeof identifier === "string" ? identifier : componentName(exportName);
		const sameName = schemaByName.get(name);
		if (sameName !== undefined && sameName.ast !== value.ast) {
			throw new Error(`Two different exported schemas are both named ${name}`);
		}
		schemaByName.set(name, value);
		add(value.ast, name);
		add(encodedSide(Schema.toCodecJson(value).ast), name);
	}
	return (ast) => {
		const contents = contentsOf(ast);
		return contents === undefined ? undefined : nameByContents.get(contents);
	};
}

/**
 * Returns the array of members an AST shares with every annotated copy of it:
 * an object's fields, a union's members, or an array's items. Two schemas
 * built separately never share one, even when they accept the same JSON. A
 * string, number or literal has none, as it's clearer written in place.
 */
function contentsOf(ast: SchemaAST.AST): ReadonlyArray<unknown> | undefined {
	switch (ast._tag) {
		case "Objects":
			return ast.propertySignatures.length > 0 ? ast.propertySignatures : undefined;
		case "Union":
			return ast.types;
		case "Arrays":
			return ast.rest;
		default:
			return undefined;
	}
}

/** Returns the AST a value of `ast` is written as, after each of its transformations. */
function encodedSide(ast: SchemaAST.AST): SchemaAST.AST {
	const lastLink = ast.encoding?.at(-1);
	return lastLink ? encodedSide(lastLink.to) : ast;
}

/** `podSchema` → `Pod`. */
function componentName(exportName: string): string {
	const base = exportName.slice(0, -"Schema".length);
	return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Returns `document` with each numbered copy of a component, such as `Pod_1`,
 * replaced by the component, `Pod`. Effect numbers an AST that asks for a
 * name another AST already has: an annotated copy of a schema, such as the one
 * a route makes to give the schema its own status, or a schema given another's
 * name at its definition because it's written as the same JSON.
 *
 * Throws when a numbered copy is written differently from its component, as it
 * then names a different schema.
 */
function withoutNumberedCopies(document: OpenApi.OpenAPISpec): OpenApi.OpenAPISpec {
	const schemas = document.components.schemas;
	const componentByCopy = new Map<string, string>();
	for (const [name, schema] of Object.entries(schemas)) {
		const component = /^(.+)_\d+$/.exec(name)?.[1];
		if (component === undefined || !(component in schemas)) continue;
		// Effect writes both from one generator, so the same schema is written in the same key order.
		if (JSON.stringify(schema) !== JSON.stringify(schemas[component])) {
			throw new Error(`${name} and ${component} are different schemas with one name`);
		}
		componentByCopy.set(name, component);
	}
	const kept = Object.entries(schemas).filter(([name]) => !componentByCopy.has(name));
	return withReferencesRenamed(
		{ ...document, components: { ...document.components, schemas: Object.fromEntries(kept) } },
		componentByCopy,
	);
}

const componentReferencePrefix = "#/components/schemas/";

/**
 * Returns `value` with each `$ref` to a component named in `newNames` pointed
 * at the component's new name. Only `$ref` values change, so a description
 * that mentions a component keeps its words.
 */
function withReferencesRenamed<Value>(value: Value, newNames: ReadonlyMap<string, string>): Value {
	const visit = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(visit);
		if (node === null || typeof node !== "object") return node;
		return Object.fromEntries(
			Object.entries(node).map(([key, child]) => [
				key,
				key === "$ref" && typeof child === "string" ? renamedReference(child) : visit(child),
			]),
		);
	};
	const renamedReference = (reference: string): string => {
		if (!reference.startsWith(componentReferencePrefix)) return reference;
		const newName = newNames.get(reference.slice(componentReferencePrefix.length));
		return newName === undefined ? reference : componentReferencePrefix + newName;
	};
	return visit(value) as Value;
}

function sortedByKey<Value>(record: Record<string, Value>): Record<string, Value> {
	return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}
