/**
 * The API as the apps see it, read from `packages/contracts/openapi.json`: its
 * named types and its routes, in terms no one language owns. Each emitter
 * writes it out in its own language and names.
 *
 * What Effect's OpenAPI means is settled here, so every language reads it
 * alike:
 *
 * - The apps are often older than the server they talk to, so an enum or a
 *   tagged union decodes a value it has never heard of as unknown rather than
 *   failing the whole response, and a field it doesn't know is ignored.
 * - Effect writes a field that may be left out as "it, or null", so a field
 *   that may also be null is that twice over. In what a request sends, such a
 *   field is `clearable`: left out, it keeps its value; sent as null, it clears it.
 * - A union whose members share a property with values of their own is told
 *   apart by it; any other is decoded by trying each member in turn.
 * - Numbers JSON can't hold are written as strings beside a number.
 * - A query carries only strings, so a number in a query is a string here too.
 */
import { camelCase, pascalCase, singular } from "./naming.ts";

// MARK: The model

/** What a value is: a type of its own, defined inline or named, or one built from others. */
export type TypeRef =
	| { kind: "string" | "integer" | "boolean" | "dateTime" | "binary" | "json" }
	/** A number, which may also come as the strings `Infinity`, `-Infinity` or `NaN`. */
	| { kind: "number"; acceptsNonFiniteStrings: boolean }
	/** One of the API's named types, by its name. */
	| { kind: "reference"; name: string }
	/** A type defined where it's used, which an emitter nests in the type that uses it. */
	| { kind: "inline"; definition: Definition }
	| { kind: "array"; items: TypeRef }
	/** An object whose keys are any strings, and whose values are all one type. */
	| { kind: "map"; values: TypeRef }
	| { kind: "nullable"; type: NonNullableTypeRef };

export type NonNullableTypeRef = Exclude<TypeRef, { kind: "nullable" }>;

export type Definition = Struct | StringEnum | TaggedUnion | UntaggedUnion | Alias;

/**
 * Every definition has a `name`: a named type's own, or for an inline one the
 * name it would like, in PascalCase, which an emitter keeps unique among the
 * types nested beside it.
 */
export interface Struct {
	kind: "struct";
	name: string;
	description?: string;
	properties: Property[];
}

export interface Property {
	jsonName: string;
	/** Its type, without the null `nullable` allows. */
	type: NonNullableTypeRef;
	required: boolean;
	nullable: boolean;
	/** May be left out, to keep the value, or sent as null, to clear it: only in what a request sends. */
	clearable: boolean;
	/** The one value a required field allows, such as a union member's `kind`, filled in so a caller needn't write it. */
	fixedValue?: string | number;
	description?: string;
}

/** A string with a few known values, which decodes any other as unknown. */
export interface StringEnum {
	kind: "enum";
	name: string;
	description?: string;
	values: string[];
}

/** A union told apart by `tag`, which decodes a tag it doesn't know as unknown. */
export interface TaggedUnion {
	kind: "taggedUnion";
	name: string;
	description?: string;
	tag: string;
	cases: TaggedCase[];
}

export interface TaggedCase {
	/** The case's name, in camelCase. */
	label: string;
	/** The values of the tag that mean this case. */
	tagValues: string[];
	type: TypeRef;
}

/** A union whose members share no tag, decoded by trying each in `decodingOrder`. */
export interface UntaggedUnion {
	kind: "untaggedUnion";
	name: string;
	description?: string;
	cases: UntaggedCase[];
	/** The cases, the one with the most to match first: a fixed string, then objects by their required fields. */
	decodingOrder: UntaggedCase[];
}

/** A case that is a value of a type, or exactly one string. */
export type UntaggedCase =
	| { label: string; type: TypeRef; literal?: undefined }
	| { label: string; type?: undefined; literal: string };

/** Another name for a type, for a named schema that isn't a struct, enum or union of its own. */
export interface Alias {
	kind: "alias";
	name: string;
	description?: string;
	type: TypeRef;
}

/** A named type and its definition. A reference to it is nullable where its schema allows null. */
export interface Component {
	name: string;
	definition: Definition;
}

/** The routes the web's client groups as `api.<name>`. */
export interface OperationGroup {
	/** The group's name, or `""` for the routes outside any group. */
	name: string;
	operations: Operation[];
}

export interface Operation {
	/** The route's name within its group, as the web's client calls it. */
	name: string;
	method: string;
	/** The route's path, with `{parameter}` placeholders. */
	path: string;
	description?: string;
	pathParameters: { name: string; type: NonNullableTypeRef }[];
	query: QueryParameter[];
	body: Payload;
	response: Payload;
}

export interface QueryParameter {
	name: string;
	type: NonNullableTypeRef;
	/** May be left out of the query. */
	optional: boolean;
	/** `single` sends one `name=value`; `repeated` sends one for each of a list's items. */
	encoding: "single" | "repeated";
}

/** A request's or response's body: none, bytes as they are, or JSON of a type. */
export type Payload = { kind: "none" } | { kind: "binary" } | { kind: "json"; type: TypeRef };

export interface ApiModel {
	/** The API's named types, by name. */
	components: Component[];
	/** The routes, by group, groups by name. Routes answered with an event stream are left out. */
	groups: OperationGroup[];
}

/** The struct a body of `type` is, when its fields can be a call's own arguments. */
export function bodyStruct(model: ApiModel, type: TypeRef): Struct | undefined {
	if (type.kind === "inline")
		return type.definition.kind === "struct" ? type.definition : undefined;
	if (type.kind !== "reference") return undefined;
	const definition = model.components.find((component) => component.name === type.name)?.definition;
	return definition?.kind === "struct" ? definition : undefined;
}

// MARK: OpenAPI

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = { [key: string]: Json };

interface OpenApiOperation {
	operationId: string;
	summary?: string;
	description?: string;
	parameters?: OpenApiParameter[];
	requestBody?: { content: Record<string, { schema: Schema }> };
	responses: Record<string, { content?: Record<string, { schema: Schema }> }>;
}

interface OpenApiParameter {
	name: string;
	in: "path" | "query";
	required?: boolean;
	description?: string;
	schema: Schema;
}

export interface OpenApiDocument {
	paths: Record<string, Record<string, OpenApiOperation>>;
	components: { schemas: Record<string, Schema> };
}

/** The routes whose answer is a stream, which each app reads itself. */
const streamContentType = "text/event-stream";

const componentPrefix = "#/components/schemas/";

/** Numbers JSON can't hold, which Effect writes as strings beside a number. */
const nonFiniteNumbers = ["Infinity", "-Infinity", "NaN"];

const isNull = (schema: Json) => isObject(schema) && schema.type === "null";

function isObject(value: Json | undefined): value is Schema {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(value: Json | undefined): Schema[] {
	return Array.isArray(value) ? value.filter(isObject) : [];
}

function descriptionOf(schema: Schema): string | undefined {
	return typeof schema.description === "string" ? schema.description : undefined;
}

/** `type`, allowing null too. */
function nullable(type: TypeRef): TypeRef {
	return type.kind === "nullable" ? type : { kind: "nullable", type };
}

function withoutNull(type: TypeRef): NonNullableTypeRef {
	return type.kind === "nullable" ? type.type : type;
}

/** The members of a union, nested unions flattened, and whether `null` is one of them. */
function unionMembers(schema: Schema): { members: Schema[]; nullable: boolean } {
	const members: Schema[] = [];
	let nullable = false;
	for (const member of list(schema.anyOf ?? schema.oneOf)) {
		if (isNull(member)) {
			nullable = true;
		} else if (member.anyOf || member.oneOf) {
			const inner = unionMembers(member);
			members.push(...inner.members);
			nullable ||= inner.nullable;
		} else {
			members.push(member);
		}
	}
	return { members, nullable };
}

/**
 * Whether a field that may be left out may also be sent as null, to clear it.
 * Effect writes a field that may be left out as "it, or null", so one that may
 * also be null is that twice over: `optional(NullOr(...))`.
 */
function isClearable(schema: Schema): boolean {
	const members = list(schema.anyOf ?? schema.oneOf);
	return (
		members.some(isNull) &&
		members.some((member) => list(member.anyOf ?? member.oneOf).some(isNull))
	);
}

/** The string values a schema allows, when it allows only a few. */
function stringValues(schema: Schema): string[] | undefined {
	if (!Array.isArray(schema.enum)) return undefined;
	if (!schema.enum.every((value) => typeof value === "string")) return undefined;
	return schema.enum as string[];
}

/** What a schema that is one thing or null is, when that thing is a type of its own. */
function nullableMember(schema: Schema): Schema | undefined {
	if (!schema.anyOf && !schema.oneOf) return undefined;
	const { members, nullable } = unionMembers(schema);
	const [only] = members;
	if (!nullable || members.length !== 1 || !only || only.$ref) return undefined;
	const isOwnType =
		(only.type === "object" && isObject(only.properties)) || (stringValues(only)?.length ?? 0) > 1;
	return isOwnType ? only : undefined;
}

/** The one value an object's field allows, such as the `http` of `kind: "http"`, to name the object by. */
function literalField(schema: Schema): string | undefined {
	const properties = isObject(schema.properties) ? Object.values(schema.properties) : [];
	for (const property of properties) {
		if (!isObject(property)) continue;
		const [only] = property.anyOf || property.oneOf ? unionMembers(property).members : [property];
		const values = only ? stringValues(only) : undefined;
		if (values?.length === 1 && values[0]) return camelCase(values[0]);
	}
	return undefined;
}

/** The one value a field allows. */
function fixedValueOf(schema: Schema): string | number | undefined {
	if (!Array.isArray(schema.enum) || schema.enum.length !== 1) return undefined;
	const [value] = schema.enum;
	return typeof value === "string" || typeof value === "number" ? value : undefined;
}

/** The name of the component a `$ref` names, if it names one. */
function referencedComponent(schema: Schema): string | undefined {
	const reference = schema.$ref;
	if (typeof reference !== "string" || !reference.startsWith(componentPrefix)) return undefined;
	return reference.slice(componentPrefix.length);
}

/**
 * Reads the model from an OpenAPI document. `sent` says whether the type being
 * read is one a request sends, where a field left out and a field sent as null
 * differ; inline types inherit it from where they're used.
 */
class ModelReader {
	private readonly components: Record<string, Schema>;
	/** Named schemas that are something or null: each is defined as the something, and referred to as nullable. */
	private readonly nullableComponents: Set<string>;
	/** The named schemas some request sends. */
	private readonly sentComponents: Set<string>;
	private readonly document: OpenApiDocument;

	constructor(document: OpenApiDocument) {
		this.document = document;
		this.components = document.components.schemas;
		this.nullableComponents = new Set(
			Object.entries(this.components)
				.filter(([, schema]) => nullableMember(schema) !== undefined)
				.map(([name]) => name),
		);
		this.sentComponents = this.componentsSent();
	}

	read(): ApiModel {
		return {
			components: Object.entries(this.components)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([name, schema]) => ({
					name: pascalCase(name),
					definition: this.component(name, schema),
				})),
			groups: this.groups(),
		};
	}

	private componentsSent(): Set<string> {
		const sent = new Set<string>();
		const visit = (value: Json | undefined): void => {
			if (Array.isArray(value)) {
				for (const item of value) visit(item);
				return;
			}
			if (!isObject(value)) return;
			const name = referencedComponent(value);
			if (name !== undefined) {
				if (sent.has(name)) return;
				sent.add(name);
				visit(this.components[name]);
			}
			for (const child of Object.values(value)) visit(child);
		};
		for (const operations of Object.values(this.document.paths)) {
			for (const operation of Object.values(operations)) visit(operation.requestBody as Json);
		}
		return sent;
	}

	private resolve(schema: Schema): Schema {
		const name = referencedComponent(schema);
		const target = name === undefined ? undefined : this.components[name];
		return target ? this.resolve(target) : schema;
	}

	// MARK: Types

	/** The type of `schema`. One that needs a type of its own, written inline, is named from `hint`. */
	private typeOf(schema: Schema, hint: string, sent: boolean): TypeRef {
		const component = referencedComponent(schema);
		if (component !== undefined) {
			const reference: TypeRef = { kind: "reference", name: pascalCase(component) };
			return this.nullableComponents.has(component) ? nullable(reference) : reference;
		}
		if (schema.anyOf || schema.oneOf) {
			const members = unionMembers(schema);
			const type = this.unionType(members.members, hint, sent);
			return members.nullable ? nullable(type) : type;
		}
		const values = stringValues(schema);
		if (values && values.length > 1) {
			return inline(stringEnum(pascalCase(hint), values, descriptionOf(schema)));
		}
		if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === "number")) {
			return schema.enum.every(Number.isInteger)
				? { kind: "integer" }
				: { kind: "number", acceptsNonFiniteStrings: false };
		}
		switch (schema.type) {
			case "string":
				if (schema.format === "date-time") return { kind: "dateTime" };
				if (schema.format === "binary") return { kind: "binary" };
				return { kind: "string" };
			case "integer":
				return { kind: "integer" };
			case "number":
				return { kind: "number", acceptsNonFiniteStrings: false };
			case "boolean":
				return { kind: "boolean" };
			case "array": {
				const items = isObject(schema.items) ? schema.items : {};
				return { kind: "array", items: this.typeOf(items, singular(hint), sent) };
			}
			case "object":
				return this.objectType(schema, hint, sent);
			default:
				return { kind: "json" };
		}
	}

	private objectType(schema: Schema, hint: string, sent: boolean): TypeRef {
		if (isObject(schema.properties) && Object.keys(schema.properties).length > 0) {
			return inline(this.struct(pascalCase(hint), schema, sent));
		}
		if (isObject(schema.additionalProperties)) {
			return {
				kind: "map",
				values: this.typeOf(schema.additionalProperties, singular(hint), sent),
			};
		}
		const patterns = isObject(schema.patternProperties)
			? Object.values(schema.patternProperties)
			: [];
		const [pattern] = patterns.filter(isObject);
		if (patterns.length === 1 && pattern) {
			return { kind: "map", values: this.typeOf(pattern, singular(hint), sent) };
		}
		return { kind: "map", values: { kind: "json" } };
	}

	private unionType(members: Schema[], hint: string, sent: boolean): TypeRef {
		if (members.length === 0) return nullable({ kind: "json" });
		const [only] = members;
		if (members.length === 1 && only) return this.typeOf(only, hint, sent);
		const kinds = members.map((member) => this.resolve(member));
		const isNonFiniteNumber = (member: Schema) =>
			stringValues(member)?.every((value) => nonFiniteNumbers.includes(value)) ?? false;
		if (
			kinds.some((member) => member.type === "number") &&
			kinds.every((member) => member.type === "number" || isNonFiniteNumber(member))
		) {
			return { kind: "number", acceptsNonFiniteStrings: true };
		}
		const strings = kinds.map(stringValues);
		const hasReference = members.some((member) => member.$ref);
		if (strings.every((values) => values !== undefined) && !hasReference) {
			return inline(stringEnum(pascalCase(hint), [...new Set(strings.flat())], undefined));
		}
		const primitives = kinds.map((member) =>
			member.type === "object" || member.type === "array" || stringValues(member)
				? undefined
				: member.type,
		);
		const [firstPrimitive] = primitives;
		if (firstPrimitive && primitives.every((type) => type === firstPrimitive) && !hasReference) {
			// Differently checked strings, such as an id or a slug, are one string here.
			return this.typeOf(kinds[0] ?? {}, hint, sent);
		}
		return inline(this.union(pascalCase(hint), members, undefined, sent));
	}

	// MARK: Definitions

	private struct(name: string, schema: Schema, sent: boolean): Struct {
		const required = new Set(Array.isArray(schema.required) ? schema.required : []);
		const properties = isObject(schema.properties) ? schema.properties : {};
		return {
			kind: "struct",
			name,
			description: descriptionOf(schema),
			properties: Object.entries(properties).flatMap(([jsonName, value]) => {
				if (!isObject(value)) return [];
				const isRequired = required.has(jsonName);
				const type = this.typeOf(value, camelCase(jsonName) || "value", sent);
				const fixedValue = fixedValueOf(value);
				const property: Property = {
					jsonName,
					type: withoutNull(type),
					required: isRequired,
					nullable: type.kind === "nullable",
					clearable: !isRequired && sent && isClearable(value),
					description: descriptionOf(value),
				};
				if (fixedValue !== undefined && isRequired) property.fixedValue = fixedValue;
				return [property];
			}),
		};
	}

	/** The property every member of a union carries with values of its own, which tells them apart. */
	private discriminator(
		members: Schema[],
	): { property: string; valuesByMember: string[][] } | undefined {
		const resolved = members.map((member) => this.resolve(member));
		if (!resolved.every((member) => member.type === "object" && isObject(member.properties))) {
			return undefined;
		}
		const [first] = resolved;
		const candidates = Object.keys(isObject(first?.properties) ? first.properties : {});
		for (const property of candidates) {
			const valuesByMember = resolved.map((member) => {
				const value = isObject(member.properties) ? member.properties[property] : undefined;
				return isObject(value) ? stringValues(this.resolve(value)) : undefined;
			});
			if (!valuesByMember.every((values) => values !== undefined && values.length > 0)) continue;
			const all = (valuesByMember as string[][]).flat();
			if (new Set(all).size === all.length)
				return { property, valuesByMember: valuesByMember as string[][] };
		}
		return undefined;
	}

	private union(
		name: string,
		members: Schema[],
		description: string | undefined,
		sent: boolean,
	): TaggedUnion | UntaggedUnion {
		const tagged = this.discriminator(members);
		if (!tagged) return this.untaggedUnion(name, members, description, sent);
		return {
			kind: "taggedUnion",
			name,
			description,
			tag: tagged.property,
			cases: members.map((member, index) => {
				const tagValues = tagged.valuesByMember[index] ?? [];
				const label = camelCase(tagValues.join(" or ")) || `case${index}`;
				return { label, tagValues, type: this.typeOf(member, pascalCase(label), sent) };
			}),
		};
	}

	private untaggedUnion(
		name: string,
		members: Schema[],
		description: string | undefined,
		sent: boolean,
	): UntaggedUnion {
		const weighted = members.map((member, index) => {
			const resolved = this.resolve(member);
			const values = stringValues(resolved);
			const [onlyValue] = values ?? [];
			if (values?.length === 1 && onlyValue !== undefined && !member.$ref) {
				const literalCase: UntaggedCase = {
					label: camelCase(onlyValue) || `case${index}`,
					literal: onlyValue,
				};
				return { entry: literalCase, weight: 1000 };
			}
			const reference = referencedComponent(member);
			const label = reference
				? camelCase(reference)
				: (primitiveLabels[String(resolved.type)] ??
					literalField(resolved) ??
					`variant${index + 1}`);
			const typedCase: UntaggedCase = {
				label,
				type: this.typeOf(member, pascalCase(label), sent),
			};
			const required = Array.isArray(resolved.required) ? resolved.required.length : 0;
			return { entry: typedCase, weight: resolved.type === "object" ? 100 + required : 0 };
		});
		return {
			kind: "untaggedUnion",
			name,
			description,
			cases: weighted.map(({ entry }) => entry),
			decodingOrder: [...weighted].sort((a, b) => b.weight - a.weight).map(({ entry }) => entry),
		};
	}

	private component(key: string, givenSchema: Schema): Definition {
		const schema = nullableMember(givenSchema) ?? givenSchema;
		const sent = this.sentComponents.has(key);
		const name = pascalCase(key);
		const description = descriptionOf(schema);
		if (schema.anyOf || schema.oneOf) {
			const { members, nullable } = unionMembers(schema);
			if (!nullable) {
				const strings = members.map(stringValues);
				if (
					strings.every((values) => values !== undefined) &&
					members.every((member) => !member.$ref)
				) {
					return stringEnum(name, [...new Set(strings.flat())], description);
				}
				return this.union(name, members, description, sent);
			}
		}
		const values = stringValues(schema);
		if (values && values.length > 1) return stringEnum(name, values, description);
		if (schema.type === "object" && isObject(schema.properties))
			return this.struct(name, schema, sent);
		// Anything else, such as a nullable union, is another name for the type it spells.
		return { kind: "alias", name, description, type: this.typeOf(schema, `${name}Value`, sent) };
	}

	// MARK: Operations

	private groups(): OperationGroup[] {
		const groups = new Map<string, Operation[]>();
		for (const [path, operations] of Object.entries(this.document.paths)) {
			for (const [method, operation] of Object.entries(operations)) {
				const group = operation.operationId.includes(".")
					? (operation.operationId.split(".")[0] ?? "")
					: "";
				const read = this.operation(path, method, operation);
				groups.set(group, [...(groups.get(group) ?? []), ...(read ? [read] : [])]);
			}
		}
		return [...groups]
			.sort(([a], [b]) => a.localeCompare(b))
			.filter(([, operations]) => operations.length > 0)
			.map(([name, operations]) => ({ name, operations }));
	}

	/** A route, or nothing for one answered with an event stream. */
	private operation(
		path: string,
		method: string,
		operation: OpenApiOperation,
	): Operation | undefined {
		const success = Object.entries(operation.responses)
			.filter(([status]) => status.startsWith("2"))
			.sort(([a], [b]) => a.localeCompare(b))[0]?.[1];
		if (success?.content?.[streamContentType]) return undefined;
		const name = operation.operationId.split(".").pop() ?? operation.operationId;
		const hint = pascalCase(name);
		const parameters = operation.parameters ?? [];
		const pathParameters = parameters
			.filter((parameter) => parameter.in === "path")
			.map((parameter) => ({
				name: parameter.name,
				type: withoutNull(
					this.typeOf(parameter.schema, `${hint}${pascalCase(parameter.name)}`, false),
				),
			}));
		const query = parameters
			.filter((parameter) => parameter.in === "query")
			.map((parameter): QueryParameter => {
				const type = this.typeOf(parameter.schema, `${hint}${pascalCase(parameter.name)}`, false);
				const base = withoutNull(type);
				return {
					name: parameter.name,
					type: base,
					optional: !parameter.required || type.kind === "nullable",
					encoding: base.kind === "array" ? "repeated" : "single",
				};
			});
		const body = this.requestBody(operation, hint);
		const json = success?.content?.["application/json"]?.schema;
		const response: Payload = json
			? { kind: "json", type: this.typeOf(json, `${hint}Response`, false) }
			: success?.content?.["application/octet-stream"]
				? { kind: "binary" }
				: { kind: "none" };
		return {
			name,
			method: method.toUpperCase(),
			path,
			description: operation.description ?? operation.summary,
			pathParameters,
			query,
			body,
			response,
		};
	}

	private requestBody(operation: OpenApiOperation, hint: string): Payload {
		const content = operation.requestBody?.content ?? {};
		if (content["application/octet-stream"]) return { kind: "binary" };
		const schema = content["application/json"]?.schema;
		if (!schema) return { kind: "none" };
		return { kind: "json", type: this.typeOf(schema, `${hint}Body`, true) };
	}
}

/** What an untagged union's case of a plain type is called. */
const primitiveLabels: Record<string, string> = {
	integer: "integer",
	number: "number",
	string: "string",
	boolean: "bool",
	array: "array",
};

function inline(definition: Definition): TypeRef {
	return { kind: "inline", definition };
}

function stringEnum(name: string, values: string[], description: string | undefined): StringEnum {
	return { kind: "enum", name, description, values };
}

export function readModel(document: OpenApiDocument): ApiModel {
	return new ModelReader(document).read();
}
