import { Schema, SchemaAST } from "effect";
import { HttpApi } from "effect/unstable/httpapi";
import { expect, it } from "vitest";
import { operationContracts } from "../operations/index.ts";
import { Api } from "./api.ts";
import { failureForError, type ServedErrorTag } from "./errors.ts";

/**
 * The record of the public HTTP API in `http-api.json`: each endpoint's
 * method and path, the status it answers with, the fields of its path, query
 * and body with their types on the wire, and the status of each failure; for
 * an operation's endpoint, the status of each of its errors by tag. It is
 * written from the API the server serves, and kept in the repository, so a
 * change to the public API shows up as a change to that file, which a
 * reviewer reads.
 *
 * After changing the API on purpose, run `bun run test --project contracts -u`
 * and review the file's diff.
 */
it("matches the record of the public HTTP API, which a change to the API is to update", async () => {
	await expect(`${JSON.stringify(recordOf(Api), null, "\t")}\n`).toMatchFileSnapshot(
		"./http-api.json",
	);
});

/** One endpoint, as the record writes it. */
interface RecordedEndpoint {
	readonly route: string;
	readonly answers: ReadonlyArray<number>;
	readonly params: Record<string, string>;
	readonly query: Record<string, string>;
	readonly body: Record<string, string> | string;
	readonly errors: Record<string, number>;
}

function recordOf(api: typeof Api) {
	const definitions: Record<string, string> = {};
	const operations: Record<string, RecordedEndpoint> = {};
	const ownEndpoints: Record<string, RecordedEndpoint> = {};
	HttpApi.reflect(api, {
		onGroup() {},
		onEndpoint({ group, endpoint }) {
			const name = `${group.identifier}.${endpoint.identifier}`;
			const contract = (
				operationContracts as Record<
					string,
					(typeof operationContracts)[keyof typeof operationContracts]
				>
			)[name];
			const isOperation = contract?.http.kind === "offered";
			const payloads = [...endpoint.payload.values()].flatMap(({ schemas }) => schemas);
			const recorded: RecordedEndpoint = {
				route: `${endpoint.method} ${endpoint.path}`,
				answers: [...endpoint.success].map(statusOf).sort(),
				params: fieldsOf(endpoint.params, definitions),
				query: fieldsOf(endpoint.query, definitions),
				body:
					payloads.length === 0
						? {}
						: payloads.length === 1 && payloads[0] !== undefined && isStruct(payloads[0])
							? fieldsOf(payloads[0], definitions)
							: payloads.map((payload) => describeSchema(payload, definitions)).join(" | "),
				errors: isOperation
					? Object.fromEntries(
							contract.errors
								.map((error) => (error as unknown as { identifier: ServedErrorTag }).identifier)
								.sort()
								.map((tag) => [tag, failureForError[tag].status]),
						)
					: Object.fromEntries(
							[...endpoint.error]
								.map((failure) => [identifierOf(failure), statusOf(failure)] as const)
								.sort(([a], [b]) => a.localeCompare(b)),
						),
			};
			(isOperation ? operations : ownEndpoints)[name] = recorded;
		},
	});
	return {
		operations: sortedByKey(operations),
		ownEndpoints: sortedByKey(ownEndpoints),
		definitions: sortedByKey(definitions),
	};
}

const statusOf = (schema: Schema.Top): number =>
	SchemaAST.resolveAt<number>("httpApiStatus")(schema.ast) ?? 200;

const identifierOf = (schema: Schema.Top): string =>
	SchemaAST.resolveAt<string>("identifier")(schema.ast) ?? describeSchema(schema, {});

const isStruct = (schema: Schema.Top): boolean =>
	SchemaAST.toEncoded(schema.ast)._tag === "Objects";

/** Each field of a struct schema, by name, with its type on the wire. */
function fieldsOf(
	schema: Schema.Top | undefined,
	definitions: Record<string, string>,
): Record<string, string> {
	if (schema === undefined) return {};
	const { schema: json, definitions: found } = Schema.toJsonSchemaDocument(schema) as unknown as {
		schema: JsonSchema;
		definitions: Record<string, JsonSchema>;
	};
	recordDefinitions(found, definitions);
	const required = new Set(json.required ?? []);
	return Object.fromEntries(
		Object.entries(json.properties ?? {}).map(([field, type]) => [
			field,
			`${required.has(field) ? "" : "optional "}${describe(type)}`,
		]),
	);
}

function describeSchema(schema: Schema.Top, definitions: Record<string, string>): string {
	const { schema: json, definitions: found } = Schema.toJsonSchemaDocument(schema) as unknown as {
		schema: JsonSchema;
		definitions: Record<string, JsonSchema>;
	};
	recordDefinitions(found, definitions);
	return describe(json);
}

function recordDefinitions(found: Record<string, JsonSchema>, into: Record<string, string>): void {
	for (const [name, definition] of Object.entries(found ?? {})) into[name] = describe(definition);
}

/** The parts of a JSON Schema the record describes; constraints such as lengths are left out. */
interface JsonSchema {
	readonly type?: string | ReadonlyArray<string>;
	readonly enum?: ReadonlyArray<unknown>;
	readonly const?: unknown;
	readonly anyOf?: ReadonlyArray<JsonSchema>;
	readonly oneOf?: ReadonlyArray<JsonSchema>;
	readonly allOf?: ReadonlyArray<JsonSchema>;
	readonly items?: JsonSchema;
	readonly prefixItems?: ReadonlyArray<JsonSchema>;
	readonly properties?: Record<string, JsonSchema>;
	readonly additionalProperties?: boolean | JsonSchema;
	readonly required?: ReadonlyArray<string>;
	readonly $ref?: string;
	readonly format?: string;
}

/** A JSON Schema as a short type, such as `{ id: uuid; name?: string }`. */
const describe = (schema: JsonSchema): string => alternativesOf(schema).join(" | ");

/** The types a JSON Schema allows, each once, as `describe` writes them. */
function alternativesOf(schema: JsonSchema): ReadonlyArray<string> {
	if (schema.$ref) return [schema.$ref.slice(schema.$ref.lastIndexOf("/") + 1)];
	const union = schema.anyOf ?? schema.oneOf;
	if (union) return [...new Set(union.flatMap(alternativesOf))];
	if (schema.allOf) return [schema.allOf.map(describe).join(" & ")];
	if (schema.enum) return schema.enum.map((value) => JSON.stringify(value));
	if ("const" in schema) return [JSON.stringify(schema.const)];
	if (Array.isArray(schema.type)) {
		return [...new Set(schema.type.flatMap((type) => alternativesOf({ ...schema, type })))];
	}
	switch (schema.type) {
		case "string":
			return [schema.format ?? "string"];
		case "integer":
		case "number":
		case "boolean":
		case "null":
			return [schema.type];
		case "array":
			if (schema.prefixItems) return [`[${schema.prefixItems.map(describe).join(", ")}]`];
			return [`Array<${schema.items ? describe(schema.items) : "unknown"}>`];
		case "object": {
			const required = new Set(schema.required ?? []);
			const fields = Object.entries(schema.properties ?? {}).map(
				([field, type]) => `${field}${required.has(field) ? "" : "?"}: ${describe(type)}`,
			);
			if (fields.length > 0) return [`{ ${fields.join("; ")} }`];
			const values = schema.additionalProperties;
			return [typeof values === "object" ? `Record<string, ${describe(values)}>` : "object"];
		}
		default:
			return ["unknown"];
	}
}

const sortedByKey = <Value>(record: Record<string, Value>): Record<string, Value> =>
	Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
