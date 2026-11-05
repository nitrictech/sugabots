/**
 * The API as the apps see it, read from `packages/contracts/openapi.json`: its
 * named types and its routes, in terms no one language owns. Each emitter
 * writes it out in its own language.
 *
 * What Effect's OpenAPI means is settled here, so every language reads it
 * alike:
 *
 * - The apps are often older than the server they talk to, so an enum or a
 *   tagged union decodes a value it has never heard of as unknown rather than
 *   failing the whole response, and a field it doesn't know is ignored.
 * - Effect writes a field that may be left out as "it, or null", so a field
 *   that may also be null is that twice over. In what a request sends, such a
 *   field is clearable: left out, it keeps its value; sent as null, it clears it.
 * - A union whose members share a property with values of their own is told
 *   apart by it; any other is decoded by trying each member in turn.
 * - Numbers JSON can't hold are written as strings beside a number.
 * - A query carries only strings, so Effect writes a number in one as a string
 *   of digits. It is an integer here, which each app writes out as text.
 *
 * Every name is settled here too: each inline type's, kept apart from the types
 * nested beside and around it and from the API's types it would hide, and each
 * field's and case's, kept apart from the others in its type.
 */
import {
	camelCase,
	MemberNames,
	pascalCase,
	reservedTypeNames,
	singular,
	TypeScope,
} from "./naming.ts";

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
 * Every definition has a `name`, in PascalCase: a named type's own, or an
 * inline one's, unique among the types nested beside it, different from the
 * types it is nested in, and never one of the API's types that the type it is
 * nested in refers to, which it would hide there. An inline type in an alias
 * sits beside the alias, at the top of the file, where its name is unique too.
 */
export interface Struct {
	kind: "struct";
	name: string;
	description?: string;
	properties: Property[];
}

export interface Property {
	jsonName: string;
	/** Its name as a field or an argument, in camelCase, unique among its struct's. */
	name: string;
	/** Its type, without the null `presence` may allow. */
	type: NonNullableTypeRef;
	presence: Presence;
	description?: string;
}

/** Whether a field must be there, and whether it may be null. */
export type Presence =
	/** Always there, and never null. */
	| { kind: "required" }
	/** Always there, maybe as null, which is written out rather than left out. */
	| { kind: "requiredOrNull" }
	/** May be left out; where it's read, null means the same. */
	| { kind: "optional" }
	/** Only in what a request sends: left out, it keeps its value; sent as null, it clears it. */
	| { kind: "clearable" }
	/** Always there with the one value it allows, such as a union member's `kind`, filled in so a caller needn't write it. */
	| { kind: "fixed"; value: string | number };

/** A string with a few known values, which decodes any other as unknown. */
export interface StringEnum {
	kind: "enum";
	name: string;
	description?: string;
	cases: EnumCase[];
	/** The case a value it doesn't know is, in camelCase, unique among `cases`' labels. */
	unknownLabel: string;
}

export interface EnumCase {
	value: string;
	/** The case's name, in camelCase, unique among its enum's. */
	label: string;
}

/** A union told apart by `tag`, which decodes a tag it doesn't know as unknown. */
export interface TaggedUnion {
	kind: "taggedUnion";
	name: string;
	description?: string;
	tag: string;
	cases: TaggedCase[];
	/** The case a tag it doesn't know is, holding that tag. */
	unknownCase: { label: string; className: string };
}

export interface TaggedCase {
	/** The case's name, in camelCase, unique among its union's. */
	label: string;
	/**
	 * The name of the type nested in the union that this case is, for a
	 * language whose union cases are types: an inline struct's own, or another
	 * that wraps the case's value.
	 */
	className: string;
	/** The values of the tag that mean this case. */
	tagValues: string[];
	type: TypeRef;
}

/**
 * A union whose members share no tag, decoded by trying each case in the order
 * `cases` lists them: exact strings first, then objects, those requiring the
 * most fields first, then anything else.
 */
export interface UntaggedUnion {
	kind: "untaggedUnion";
	name: string;
	description?: string;
	cases: UntaggedCase[];
}

/** A case that is a value of a type, or exactly one string. `label` and `className` are as a tagged case's. */
export type UntaggedCase =
	| { label: string; className: string; type: TypeRef; literal?: undefined }
	| { label: string; className: string; type?: undefined; literal: string };

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
	pathParameters: PathParameter[];
	query: QueryParameter[];
	body: RequestBody;
	response: Payload;
}

export interface PathParameter {
	name: string;
	/** Its name as an argument, in camelCase, unique among the route's parameters. */
	argumentName: string;
	type: NonNullableTypeRef;
}

export interface QueryParameter {
	name: string;
	/** Its name as an argument, in camelCase, unique among the route's parameters. */
	argumentName: string;
	type: NonNullableTypeRef;
	/** May be left out of the query. */
	optional: boolean;
	/** `single` sends one `name=value`; `repeated` sends one for each of a list's items. */
	encoding: "single" | "repeated";
}

/** A response's body: none, bytes as they are, or JSON of a type. */
export type Payload = { kind: "none" } | { kind: "binary" } | { kind: "json"; type: TypeRef };

/** A request's body: none, bytes as they are, or JSON of a type. */
export type RequestBody =
	| { kind: "none" }
	| { kind: "binary" }
	| {
			kind: "json";
			type: TypeRef;
			/**
			 * The fields a call takes as its own arguments, so a call reads
			 * `update(podId:name:)`: a struct body's fields but its fixed ones,
			 * unless one shares a name with a path or query parameter, when the
			 * call takes the body whole.
			 */
			fields?: Property[];
	  };

export interface ApiModel {
	/** The API's named types, by name. */
	components: Component[];
	/** The routes, by group, groups by name. Routes answered with an event stream are left out. */
	groups: OperationGroup[];
}

/** The types an operation names, in the order it names them. */
export function operationTypes(operation: Operation): TypeRef[] {
	return [
		...operation.pathParameters.map((parameter) => parameter.type),
		...operation.query.map((parameter) => parameter.type),
		...(operation.body.kind === "json" ? [operation.body.type] : []),
		...(operation.response.kind === "json" ? [operation.response.type] : []),
	];
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

/** The names of the API's types that `value` refers to anywhere within it, without following them. */
function referencedNames(value: Json | undefined, names = new Set<string>()): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) referencedNames(item, names);
		return names;
	}
	if (!isObject(value)) return names;
	const name = referencedComponent(value);
	if (name !== undefined) names.add(pascalCase(name));
	for (const child of Object.values(value)) referencedNames(child, names);
	return names;
}

/**
 * The scope of the types nested in a type at the top of the file called
 * `name`, defined by `schemas`: their names mustn't hide one of the API's types
 * that `schemas` refers to.
 */
function outermostScope(
	name: string,
	schemas: Json,
	alsoReserved: ReadonlySet<string> = new Set(),
): TypeScope {
	const referenced = referencedNames(schemas);
	return new TypeScope(
		name,
		(candidate) =>
			reservedTypeNames.has(candidate) || referenced.has(candidate) || alsoReserved.has(candidate),
	);
}

/** The pattern of a query's number, which Effect writes as a string of digits. */
const digitsPattern = "^\\d+$";

/** Whether `schema`, perhaps or null, is a number written as a string of digits. */
function isDigitString(schema: Schema): boolean {
	const members = schema.anyOf || schema.oneOf ? unionMembers(schema).members : [schema];
	const [only] = members;
	return members.length === 1 && only?.type === "string" && only.pattern === digitsPattern;
}

/** The class a group's routes are functions of. */
export function routesClassName(groupName: string): string {
	return `${pascalCase(groupName)}Routes`;
}

/** The name of the scope the routes outside any group, and the types they define inline, are in. */
const ungroupedScopeName = "ApiClient";

/** The order an untagged union's cases are tried in, by what each matches. */
const decodingTiers = ["exactString", "object", "other"] as const;

interface UntaggedCaseRead {
	entry: UntaggedCase;
	tier: (typeof decodingTiers)[number];
	/** How many fields an object requires: of two objects, the one requiring more is tried first. */
	requiredFields: number;
}

function byDecodingOrder(a: UntaggedCaseRead, b: UntaggedCaseRead): number {
	const tierOrder = decodingTiers.indexOf(a.tier) - decodingTiers.indexOf(b.tier);
	return tierOrder !== 0 ? tierOrder : b.requiredFields - a.requiredFields;
}

function isInlineStruct(type: TypeRef): type is { kind: "inline"; definition: Struct } {
	return type.kind === "inline" && type.definition.kind === "struct";
}

/**
 * Reads the model from an OpenAPI document. `sent` says whether the type being
 * read is one a request sends, where a field left out and a field sent as null
 * differ; inline types inherit it from where they're used. `scope` is where an
 * inline type being read is nested, which names it.
 */
class ModelReader {
	private readonly components: Record<string, Schema>;
	/** Named schemas that are something or null: each is defined as the something, and referred to as nullable. */
	private readonly nullableComponents: Set<string>;
	/** The named schemas some request sends. */
	private readonly sentComponents: Set<string>;
	private readonly document: OpenApiDocument;
	/** The routes by the name of their group, groups by name. */
	private readonly routesByGroup: Map<string, Route[]>;
	/** The top of the file, where the inline types an alias uses sit beside it, since an alias can't hold them. */
	private readonly topLevel: TypeScope;
	/** The API's named types read so far, by name. */
	private readonly definitions = new Map<string, Definition>();

	constructor(document: OpenApiDocument) {
		this.document = document;
		this.components = document.components.schemas;
		this.nullableComponents = new Set(
			Object.entries(this.components)
				.filter(([, schema]) => nullableMember(schema) !== undefined)
				.map(([name]) => name),
		);
		this.sentComponents = this.componentsSent();
		this.routesByGroup = this.routesGrouped();
		const topLevelNames = new Set([
			...Object.keys(this.components).map(pascalCase),
			...[...this.routesByGroup.keys()].filter(Boolean).map(routesClassName),
		]);
		this.topLevel = new TypeScope(
			"",
			(name) => reservedTypeNames.has(name) || topLevelNames.has(name),
		);
	}

	read(): ApiModel {
		const components = Object.entries(this.components)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, schema]): Component => {
				const definition = this.component(key, schema);
				this.definitions.set(definition.name, definition);
				return { name: definition.name, definition };
			});
		return { components, groups: this.groups() };
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
	private typeOf(schema: Schema, hint: string, sent: boolean, scope: TypeScope): TypeRef {
		const component = referencedComponent(schema);
		if (component !== undefined) {
			const reference: TypeRef = { kind: "reference", name: pascalCase(component) };
			return this.nullableComponents.has(component) ? nullable(reference) : reference;
		}
		if (schema.anyOf || schema.oneOf) {
			const members = unionMembers(schema);
			const type = this.unionType(members.members, hint, sent, scope);
			return members.nullable ? nullable(type) : type;
		}
		const values = stringValues(schema);
		if (values && values.length > 1) {
			return inline(stringEnum(scope.claim(pascalCase(hint)), values, descriptionOf(schema)));
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
				return { kind: "array", items: this.typeOf(items, singular(hint), sent, scope) };
			}
			case "object":
				return this.objectType(schema, hint, sent, scope);
			default:
				return { kind: "json" };
		}
	}

	private objectType(schema: Schema, hint: string, sent: boolean, scope: TypeScope): TypeRef {
		if (isObject(schema.properties) && Object.keys(schema.properties).length > 0) {
			const name = scope.claim(pascalCase(hint));
			return inline(this.struct(name, schema, sent, scope.nested(name)));
		}
		if (isObject(schema.additionalProperties)) {
			return {
				kind: "map",
				values: this.typeOf(schema.additionalProperties, singular(hint), sent, scope),
			};
		}
		const patterns = isObject(schema.patternProperties)
			? Object.values(schema.patternProperties)
			: [];
		const [pattern] = patterns.filter(isObject);
		if (patterns.length === 1 && pattern) {
			return { kind: "map", values: this.typeOf(pattern, singular(hint), sent, scope) };
		}
		return { kind: "map", values: { kind: "json" } };
	}

	private unionType(members: Schema[], hint: string, sent: boolean, scope: TypeScope): TypeRef {
		if (members.length === 0) return nullable({ kind: "json" });
		const [only] = members;
		if (members.length === 1 && only) return this.typeOf(only, hint, sent, scope);
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
			const name = scope.claim(pascalCase(hint));
			return inline(stringEnum(name, [...new Set(strings.flat())], undefined));
		}
		const primitives = kinds.map((member) =>
			member.type === "object" || member.type === "array" || stringValues(member)
				? undefined
				: member.type,
		);
		const [firstPrimitive] = primitives;
		if (firstPrimitive && primitives.every((type) => type === firstPrimitive) && !hasReference) {
			// Differently checked strings, such as an id or a slug, are one string here.
			return this.typeOf(kinds[0] ?? {}, hint, sent, scope);
		}
		const name = scope.claim(pascalCase(hint));
		return inline(this.union(name, members, undefined, sent, scope.nested(name)));
	}

	// MARK: Definitions

	/** A struct called `name`, whose inline types are nested in `scope`. */
	private struct(name: string, schema: Schema, sent: boolean, scope: TypeScope): Struct {
		const required = new Set(Array.isArray(schema.required) ? schema.required : []);
		const properties = isObject(schema.properties) ? schema.properties : {};
		const names = new MemberNames();
		return {
			kind: "struct",
			name,
			description: descriptionOf(schema),
			properties: Object.entries(properties).flatMap(([jsonName, value]): Property[] => {
				if (!isObject(value)) return [];
				const memberName = names.claim(camelCase(jsonName) || "value");
				const type = this.typeOf(value, memberName, sent, scope);
				return [
					{
						jsonName,
						name: memberName,
						type: withoutNull(type),
						presence: presenceOf(value, type, required.has(jsonName), sent),
						description: descriptionOf(value),
					},
				];
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

	/** A union called `name`, whose case types and inline types are nested in `scope`. */
	private union(
		name: string,
		members: Schema[],
		description: string | undefined,
		sent: boolean,
		scope: TypeScope,
	): TaggedUnion | UntaggedUnion {
		const tagged = this.discriminator(members);
		if (!tagged) return this.untaggedUnion(name, members, description, sent, scope);
		const labels = new MemberNames();
		const cases = members.map((member, index): TaggedCase => {
			const tagValues = tagged.valuesByMember[index] ?? [];
			const label = labels.claim(camelCase(tagValues.join(" or ")) || `case${index}`);
			const type = this.typeOf(member, pascalCase(label), sent, scope);
			return { label, className: caseClassName(type, label, scope), tagValues, type };
		});
		return {
			kind: "taggedUnion",
			name,
			description,
			tag: tagged.property,
			cases,
			unknownCase: { label: labels.claim("unknown"), className: scope.claim("Unknown") },
		};
	}

	private untaggedUnion(
		name: string,
		members: Schema[],
		description: string | undefined,
		sent: boolean,
		scope: TypeScope,
	): UntaggedUnion {
		const labels = new MemberNames();
		const cases = members.map((member, index): UntaggedCaseRead => {
			const resolved = this.resolve(member);
			const values = stringValues(resolved);
			const [onlyValue] = values ?? [];
			if (values?.length === 1 && onlyValue !== undefined && !member.$ref) {
				const label = labels.claim(camelCase(onlyValue) || `case${index}`);
				const entry = { label, className: scope.claim(pascalCase(label)), literal: onlyValue };
				return { entry, tier: "exactString", requiredFields: 0 };
			}
			const reference = referencedComponent(member);
			const label = labels.claim(
				reference
					? camelCase(reference)
					: (primitiveLabels[String(resolved.type)] ??
							literalField(resolved) ??
							`variant${index + 1}`),
			);
			const type = this.typeOf(member, pascalCase(label), sent, scope);
			const entry = { label, className: caseClassName(type, label, scope), type };
			if (resolved.type !== "object") return { entry, tier: "other", requiredFields: 0 };
			const requiredFields = Array.isArray(resolved.required) ? resolved.required.length : 0;
			return { entry, tier: "object", requiredFields };
		});
		return {
			kind: "untaggedUnion",
			name,
			description,
			cases: cases.sort(byDecodingOrder).map(({ entry }) => entry),
		};
	}

	private component(key: string, givenSchema: Schema): Definition {
		const schema = nullableMember(givenSchema) ?? givenSchema;
		const sent = this.sentComponents.has(key);
		const name = pascalCase(key);
		const description = descriptionOf(schema);
		const scope = outermostScope(name, givenSchema);
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
				return this.union(name, members, description, sent, scope);
			}
		}
		const values = stringValues(schema);
		if (values && values.length > 1) return stringEnum(name, values, description);
		if (schema.type === "object" && isObject(schema.properties))
			return this.struct(name, schema, sent, scope);
		// Anything else, such as a nullable union, is another name for the type it spells.
		const type = this.typeOf(schema, `${name}Value`, sent, this.topLevel);
		return { kind: "alias", name, description, type };
	}

	// MARK: Operations

	private routesGrouped(): Map<string, Route[]> {
		const groups = new Map<string, Route[]>();
		for (const [path, operations] of Object.entries(this.document.paths)) {
			for (const [method, operation] of Object.entries(operations)) {
				const group = operation.operationId.includes(".")
					? (operation.operationId.split(".")[0] ?? "")
					: "";
				groups.set(group, [...(groups.get(group) ?? []), { path, method, operation }]);
			}
		}
		return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)));
	}

	private groups(): OperationGroup[] {
		const routesClassNames = new Set(
			[...this.routesByGroup.keys()].filter(Boolean).map(routesClassName),
		);
		return [...this.routesByGroup]
			.map(([name, routes]) => {
				const schemas = routes.map(({ operation }) => operation as unknown as Json);
				// The client holds each group of routes, so a type nested in it mustn't hide their classes.
				const scope = name
					? outermostScope(routesClassName(name), schemas)
					: outermostScope(ungroupedScopeName, schemas, routesClassNames);
				const operations = routes.flatMap(({ path, method, operation }) => {
					const read = this.operation(path, method, operation, scope);
					return read ? [read] : [];
				});
				return { name, operations };
			})
			.filter(({ operations }) => operations.length > 0);
	}

	/** A route, or nothing for one answered with an event stream. Its inline types are nested in `scope`. */
	private operation(
		path: string,
		method: string,
		operation: OpenApiOperation,
		scope: TypeScope,
	): Operation | undefined {
		const success = Object.entries(operation.responses)
			.filter(([status]) => status.startsWith("2"))
			.sort(([a], [b]) => a.localeCompare(b))[0]?.[1];
		if (success?.content?.[streamContentType]) return undefined;
		const name = operation.operationId.split(".").pop() ?? operation.operationId;
		const hint = pascalCase(name);
		const parameters = operation.parameters ?? [];
		const argumentNames = new MemberNames();
		const pathParameters = parameters
			.filter((parameter) => parameter.in === "path")
			.map((parameter): PathParameter => {
				const type = this.typeOf(
					parameter.schema,
					`${hint}${pascalCase(parameter.name)}`,
					false,
					scope,
				);
				return {
					name: parameter.name,
					argumentName: argumentNames.claim(camelCase(parameter.name)),
					type: withoutNull(type),
				};
			});
		const query = parameters
			.filter((parameter) => parameter.in === "query")
			.map((parameter): QueryParameter => {
				const type = this.typeOf(
					parameter.schema,
					`${hint}${pascalCase(parameter.name)}`,
					false,
					scope,
				);
				const base: NonNullableTypeRef = isDigitString(parameter.schema)
					? { kind: "integer" }
					: withoutNull(type);
				return {
					name: parameter.name,
					argumentName: argumentNames.claim(camelCase(parameter.name)),
					type: base,
					optional: !parameter.required || type.kind === "nullable",
					encoding: base.kind === "array" ? "repeated" : "single",
				};
			});
		const parameterNames = new Set(
			[...pathParameters, ...query].map((parameter) => parameter.argumentName),
		);
		const body = this.requestBody(operation, hint, scope, parameterNames);
		const json = success?.content?.["application/json"]?.schema;
		const response: Payload = json
			? { kind: "json", type: this.typeOf(json, `${hint}Response`, false, scope) }
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

	private requestBody(
		operation: OpenApiOperation,
		hint: string,
		scope: TypeScope,
		parameterNames: Set<string>,
	): RequestBody {
		const content = operation.requestBody?.content ?? {};
		if (content["application/octet-stream"]) return { kind: "binary" };
		const schema = content["application/json"]?.schema;
		if (!schema) return { kind: "none" };
		const type = this.typeOf(schema, `${hint}Body`, true, scope);
		const fields = this.structOf(type)?.properties.filter(
			(property) => property.presence.kind !== "fixed",
		);
		if (!fields || fields.some((field) => parameterNames.has(field.name))) {
			return { kind: "json", type };
		}
		return { kind: "json", type, fields };
	}

	/** The struct `type` is, defined inline or named. */
	private structOf(type: TypeRef): Struct | undefined {
		if (isInlineStruct(type)) return type.definition;
		if (type.kind !== "reference") return undefined;
		const definition = this.definitions.get(type.name);
		return definition?.kind === "struct" ? definition : undefined;
	}
}

/** One route as the document lists it. */
interface Route {
	path: string;
	method: string;
	operation: OpenApiOperation;
}

/** Whether a field of `schema`, read as `type`, must be there, and whether it may be null. */
function presenceOf(schema: Schema, type: TypeRef, required: boolean, sent: boolean): Presence {
	if (!required) return sent && isClearable(schema) ? { kind: "clearable" } : { kind: "optional" };
	const fixedValue = fixedValueOf(schema);
	if (fixedValue !== undefined) return { kind: "fixed", value: fixedValue };
	return type.kind === "nullable" ? { kind: "requiredOrNull" } : { kind: "required" };
}

/** The class a union's case of `type` is: an inline struct itself, or a wrapper claimed in `scope`. */
function caseClassName(type: TypeRef, label: string, scope: TypeScope): string {
	return isInlineStruct(type) ? type.definition.name : scope.claim(pascalCase(label));
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
	const labels = new MemberNames();
	return {
		kind: "enum",
		name,
		description,
		cases: values.map((value) => ({ value, label: labels.claim(camelCase(value) || "empty") })),
		unknownLabel: labels.claim("unknown"),
	};
}

export function readModel(document: OpenApiDocument): ApiModel {
	return new ModelReader(document).read();
}
