/**
 * Writes `Sugabots/API/API.generated.swift` from `packages/contracts/openapi.json`:
 * a Swift type for each schema the API names, and a typed request for each
 * route, grouped as the web's client groups them, so `api.threads.get(...)` in
 * TypeScript is `client.threads.get(...)` in Swift.
 *
 * The `ios` tests fail until it has been run, and the app then fails to build
 * wherever it relied on what changed.
 *
 * The app is often older than the server it talks to, so what it decodes is
 * kept open: an enum or a union decodes a value it has never heard of as
 * `unknown` rather than failing the whole response, and a field the app
 * doesn't know is ignored.
 */
import document from "../../../packages/contracts/openapi.json" with { type: "json" };
import type { GeneratedFiles } from "./generated-files.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = { [key: string]: Json };

interface Operation {
	operationId: string;
	summary?: string;
	description?: string;
	parameters?: Parameter[];
	requestBody?: { content: Record<string, { schema: Schema }> };
	responses: Record<string, { content?: Record<string, { schema: Schema }> }>;
}

interface Parameter {
	name: string;
	in: "path" | "query";
	required?: boolean;
	description?: string;
	schema: Schema;
}

export interface OpenApiDocument {
	paths: Record<string, Record<string, Operation>>;
	components: { schemas: Record<string, Schema> };
}

/** The routes whose answer is a stream, which `EventStream` reads itself. */
const streamContentType = "text/event-stream";

// MARK: Names

const swiftKeywords = new Set(
	`associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private precedencegroup protocol public rethrows static struct subscript typealias var break case catch continue default defer do else fallthrough for guard if in repeat return throw switch where while as Any false is nil self Self super throws true try Type Protocol`.split(
		" ",
	),
);

function words(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean);
}

function pascalCase(text: string): string {
	const result = words(text)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join("");
	return /^[0-9]/.test(result) ? `_${result}` : result;
}

function camelCase(text: string): string {
	const pascal = pascalCase(text);
	if (pascal.startsWith("_")) return pascal;
	// `URLs` → `urls`, `ID` → `id`, `HTTPHeader` → `httpHeader`.
	const leadingCapitals = pascal.match(/^[A-Z]+(?=[A-Z][a-z]|[0-9]|$)/)?.[0];
	if (leadingCapitals) return leadingCapitals.toLowerCase() + pascal.slice(leadingCapitals.length);
	return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** A name as Swift will take it: backquoted when it's a keyword. */
function identifier(name: string): string {
	return swiftKeywords.has(name) ? `\`${name}\`` : name;
}

function singular(name: string): string {
	if (/ies$/.test(name)) return `${name.slice(0, -3)}y`;
	if (/(ss|us|is)$/.test(name)) return `${name}Item`;
	if (/s$/.test(name)) return name.slice(0, -1);
	return `${name}Item`;
}

const swiftString = (value: string) => JSON.stringify(value);

function docComment(text: unknown, indent: string): string[] {
	if (typeof text !== "string" || text.trim() === "") return [];
	return text
		.trim()
		.split("\n")
		.map((line) => `${indent}/// ${line.trim()}`.trimEnd());
}

// MARK: Schemas

const componentPrefix = "#/components/schemas/";

const isNull = (schema: Json) => isObject(schema) && schema.type === "null";

function isObject(value: Json | undefined): value is Schema {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(value: Json | undefined): Schema[] {
	return Array.isArray(value) ? value.filter(isObject) : [];
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

/** Numbers JSON can't hold, which Effect writes as strings beside a number. */
const nonFiniteNumbers = ["Infinity", "-Infinity", "NaN"];

/** Types a nested type mustn't be named for, since it would hide them from the code around it. */
const standardTypeNames = new Set(
	"Any Array Bool Data Date Decoder Dictionary Double Encoder Error Int None Optional Result Set Some String Type URL UUID Void".split(
		" ",
	),
);

/**
 * A Swift declaration being built: a type and the types nested in it. Inline
 * schemas become nested types, named for where they appear.
 */
class Declaration {
	readonly nested: Declaration[] = [];
	/** A struct's fields. */
	properties?: Property[];
	readonly name: string;
	readonly lines: string[];
	private readonly takenNames = new Set<string>();

	constructor(name: string, lines: string[] = []) {
		this.name = name;
		this.lines = lines;
	}

	/** A name for a nested type, unique here and never one of the API's own, which it would hide. */
	claimName(wanted: string, generator: Generator): string {
		const isFree = (name: string) =>
			!this.takenNames.has(name) &&
			!generator.hiddenNames.has(name) &&
			!standardTypeNames.has(name) &&
			name !== this.name;
		// A `Routine` inside `ActivityItem` that would hide the API's own `Routine` there is `RoutineItem`.
		const ownerWord = words(this.name).pop() ?? "";
		let name = isFree(wanted) ? wanted : `${wanted}${ownerWord}`;
		for (let attempt = 2; !isFree(name); attempt += 1) name = `${wanted}${ownerWord}${attempt}`;
		this.takenNames.add(name);
		return name;
	}

	/** The names of every type nested in this one, at any depth. */
	allNestedNames(): Set<string> {
		const names = new Set<string>();
		for (const declaration of this.nested) {
			names.add(declaration.name);
			for (const name of declaration.allNestedNames()) names.add(name);
		}
		return names;
	}

	render(indent = ""): string[] {
		const [opening, ...rest] = this.lines;
		if (opening === undefined) return [];
		// A type alias can't hold types, so what it names sits beside it.
		if (rest.length === 0) {
			return [
				indent + opening,
				...this.nested.flatMap((declaration) => ["", ...declaration.render(indent)]),
			];
		}
		const closingIndex = rest.length - 1;
		const body = rest.slice(0, closingIndex).map((line) => (line ? indent + line : line));
		const nested = this.nested.flatMap((declaration) => ["", ...declaration.render(`${indent}\t`)]);
		return [indent + opening, ...body, ...nested, indent + rest[closingIndex]];
	}
}

/** One property of a struct, with how Swift holds it. */
interface Property {
	jsonName: string;
	swiftName: string;
	type: string;
	required: boolean;
	nullable: boolean;
	/** A field with one allowed value, such as a union's `kind`, filled in so a caller needn't write it. */
	literal?: string;
	description?: string;
}

class Generator {
	readonly componentNames: Set<string>;
	/**
	 * Names of the API's own types that the declaration being written refers to,
	 * which a type nested in it mustn't take, and those it has referred to so far.
	 */
	hiddenNames = new Set<string>();
	private referencedNames = new Set<string>();
	readonly components: Record<string, Schema>;
	readonly document: OpenApiDocument;
	/** The named schemas some request sends, where a field left out and a field sent as null differ. */
	private readonly sentSchemas: Set<string>;
	/** Whether the type being written is one a request sends. */
	private writingSentType = false;

	constructor(document: OpenApiDocument) {
		this.document = document;
		this.components = document.components.schemas;
		this.componentNames = new Set(Object.keys(this.components).map(pascalCase));
		this.sentSchemas = this.schemasSent();
		this.nullableComponents = new Set(
			Object.entries(this.components)
				.filter(([, schema]) => nullableMember(schema) !== undefined)
				.map(([name]) => name),
		);
	}

	/** Named schemas that are something or null: each is written as the something, and used as an optional. */
	private readonly nullableComponents: Set<string>;

	private schemasSent(): Set<string> {
		const sent = new Set<string>();
		const visit = (value: Json | undefined): void => {
			if (Array.isArray(value)) {
				for (const item of value) visit(item);
				return;
			}
			if (!isObject(value)) return;
			const reference = value.$ref;
			if (typeof reference === "string" && reference.startsWith(componentPrefix)) {
				const name = reference.slice(componentPrefix.length);
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

	resolve(schema: Schema): Schema {
		const reference = schema.$ref;
		if (typeof reference === "string" && reference.startsWith(componentPrefix)) {
			const target = this.components[reference.slice(componentPrefix.length)];
			if (target) return this.resolve(target);
		}
		return schema;
	}

	/**
	 * The Swift type for `schema`. A schema that needs a type of its own, written
	 * inline, gets one nested in `owner`, named from `hint`.
	 */
	typeOf(schema: Schema, hint: string, owner: Declaration): string {
		const reference = schema.$ref;
		if (typeof reference === "string" && reference.startsWith(componentPrefix)) {
			const component = reference.slice(componentPrefix.length);
			const name = pascalCase(component);
			this.referencedNames.add(name);
			return this.nullableComponents.has(component) ? `${name}?` : name;
		}
		if (schema.anyOf || schema.oneOf) {
			const { members, nullable } = unionMembers(schema);
			const type = this.unionType(members, hint, owner);
			return nullable && !type.endsWith("?") ? `${type}?` : type;
		}
		const values = stringValues(schema);
		if (values && values.length > 1) {
			const name = owner.claimName(pascalCase(hint), this);
			owner.nested.push(this.stringEnum(name, values, schema));
			return name;
		}
		if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === "number")) {
			return schema.enum.every(Number.isInteger) ? "Int" : "Double";
		}
		switch (schema.type) {
			case "string":
				if (schema.format === "date-time") return "Date";
				if (schema.format === "binary") return "Data";
				return "String";
			case "integer":
				return "Int";
			case "number":
				return "Double";
			case "boolean":
				return "Bool";
			case "array": {
				const items = isObject(schema.items) ? schema.items : {};
				return `[${this.typeOf(items, singular(hint), owner)}]`;
			}
			case "object":
				return this.objectType(schema, hint, owner);
			default:
				return "JSONValue";
		}
	}

	private objectType(schema: Schema, hint: string, owner: Declaration): string {
		if (isObject(schema.properties) && Object.keys(schema.properties).length > 0) {
			const name = owner.claimName(pascalCase(hint), this);
			owner.nested.push(this.struct(name, schema));
			return name;
		}
		if (isObject(schema.additionalProperties)) {
			return `[String: ${this.typeOf(schema.additionalProperties, singular(hint), owner)}]`;
		}
		const patterns = isObject(schema.patternProperties)
			? Object.values(schema.patternProperties)
			: [];
		const [pattern] = patterns.filter(isObject);
		if (patterns.length === 1 && pattern) {
			return `[String: ${this.typeOf(pattern, singular(hint), owner)}]`;
		}
		return "[String: JSONValue]";
	}

	private unionType(members: Schema[], hint: string, owner: Declaration): string {
		if (members.length === 0) return "JSONValue?";
		const [only] = members;
		if (members.length === 1 && only) return this.typeOf(only, hint, owner);
		const kinds = members.map((member) => this.resolve(member));
		const isNonFiniteNumber = (member: Schema) =>
			stringValues(member)?.every((value) => nonFiniteNumbers.includes(value)) ?? false;
		if (
			kinds.some((member) => member.type === "number") &&
			kinds.every((member) => member.type === "number" || isNonFiniteNumber(member))
		) {
			return "Double";
		}
		const strings = kinds.map(stringValues);
		if (
			strings.every((values) => values !== undefined) &&
			members.every((member) => !member.$ref)
		) {
			const name = owner.claimName(pascalCase(hint), this);
			owner.nested.push(this.stringEnum(name, [...new Set(strings.flat() as string[])], {}));
			return name;
		}
		const primitives = kinds.map((member) =>
			member.type === "object" || member.type === "array" || stringValues(member)
				? undefined
				: member.type,
		);
		const [firstPrimitive] = primitives;
		if (
			firstPrimitive &&
			primitives.every((type) => type === firstPrimitive) &&
			members.every((member) => !member.$ref)
		) {
			// Differently checked strings, such as an id or a slug, are one string here.
			return this.typeOf(kinds[0] ?? {}, hint, owner);
		}
		const name = owner.claimName(pascalCase(hint), this);
		owner.nested.push(this.union(name, members, {}));
		return name;
	}

	// MARK: Structs

	struct(name: string, schema: Schema): Declaration {
		const declaration = new Declaration(name);
		const properties = this.properties(schema, declaration);
		const needsCodingKeys = properties.some(
			(property) =>
				property.swiftName !== property.jsonName || (property.required && property.nullable),
		);
		const lines = [
			...docComment(schema.description, ""),
			`struct ${name}: Codable, Hashable, Sendable {`,
		];
		for (const property of properties) {
			lines.push(...docComment(property.description, "\t"));
			const declared = `\tvar ${identifier(property.swiftName)}: ${property.type}`;
			lines.push(property.literal === undefined ? declared : `${declared} = ${property.literal}`);
		}
		if (needsCodingKeys) lines.push("", ...this.codingKeys(properties));
		lines.push("}");
		declaration.lines.push(...lines);
		declaration.properties = properties;
		return declaration;
	}

	private properties(schema: Schema, owner: Declaration): Property[] {
		const required = new Set(Array.isArray(schema.required) ? schema.required : []);
		const properties = isObject(schema.properties) ? schema.properties : {};
		return Object.entries(properties).flatMap(([jsonName, value]) => {
			if (!isObject(value)) return [];
			const swiftName = camelCase(jsonName) || "value";
			const isRequired = required.has(jsonName);
			const literal = this.literalOf(value);
			let type = this.typeOf(value, swiftName, owner);
			const nullable = type.endsWith("?");
			const base = type.endsWith("?") ? type.slice(0, -1) : type;
			if (!isRequired && this.writingSentType && isClearable(value)) {
				// Absent leaves a value as it was; null clears it.
				type = `${base}??`;
			} else if (!isRequired || nullable) {
				type = `${base}?`;
			}
			const property: Property = {
				jsonName,
				swiftName,
				type,
				required: isRequired,
				nullable,
				description: typeof value.description === "string" ? value.description : undefined,
			};
			if (literal !== undefined && isRequired) property.literal = literal;
			return [property];
		});
	}

	/** A field that allows one value, as Swift writes that value. */
	private literalOf(schema: Schema): string | undefined {
		if (!Array.isArray(schema.enum) || schema.enum.length !== 1) return undefined;
		const [value] = schema.enum;
		if (typeof value === "string") return swiftString(value);
		if (typeof value === "number") return String(value);
		return undefined;
	}

	/** Keys for a struct whose names differ from the JSON's, or which must write a null rather than leave it out. */
	private codingKeys(properties: Property[]): string[] {
		const lines = ["\tprivate enum CodingKeys: String, CodingKey {"];
		for (const property of properties) {
			const name = identifier(property.swiftName);
			lines.push(
				property.swiftName === property.jsonName
					? `\t\tcase ${name}`
					: `\t\tcase ${name} = ${swiftString(property.jsonName)}`,
			);
		}
		lines.push("\t}");
		if (!properties.some((property) => property.required && property.nullable)) return lines;
		// A required field that may be null must be sent as null, which the synthesized encoding leaves out.
		lines.push("", "\tfunc encode(to encoder: any Encoder) throws {");
		lines.push("\t\tvar container = encoder.container(keyedBy: CodingKeys.self)");
		for (const property of properties) {
			const name = identifier(property.swiftName);
			const method = property.required ? "encode" : "encodeIfPresent";
			lines.push(`\t\ttry container.${method}(${name}, forKey: .${name})`);
		}
		lines.push("\t}");
		return lines;
	}

	// MARK: Enums

	stringEnum(name: string, values: string[], schema: Schema): Declaration {
		const cases = values.map((value) => ({ value, name: camelCase(value) || "empty" }));
		const unknownCase = cases.some((entry) => entry.name === "unknown")
			? "unrecognized"
			: "unknown";
		const lines = [
			...docComment(schema.description, ""),
			`enum ${name}: RawRepresentable, Codable, Hashable, Sendable, QueryValue {`,
			...cases.map((entry) => `\tcase ${identifier(entry.name)}`),
			"\t/// A value from a newer server than this app knows.",
			`\tcase ${unknownCase}(String)`,
			"",
			"\t/// Every value this app knows.",
			`\tstatic let known: [Self] = [${cases.map((entry) => `.${identifier(entry.name)}`).join(", ")}]`,
			"",
			"\tinit(rawValue: String) {",
			"\t\tswitch rawValue {",
			...cases.map(
				(entry) => `\t\tcase ${swiftString(entry.value)}: self = .${identifier(entry.name)}`,
			),
			`\t\tdefault: self = .${unknownCase}(rawValue)`,
			"\t\t}",
			"\t}",
			"",
			"\tvar rawValue: String {",
			"\t\tswitch self {",
			...cases.map((entry) => `\t\tcase .${identifier(entry.name)}: ${swiftString(entry.value)}`),
			`\t\tcase let .${unknownCase}(value): value`,
			"\t\t}",
			"\t}",
			"",
			"\tinit(from decoder: any Decoder) throws {",
			"\t\tself.init(rawValue: try decoder.singleValueContainer().decode(String.self))",
			"\t}",
			"",
			"\tfunc encode(to encoder: any Encoder) throws {",
			"\t\tvar container = encoder.singleValueContainer()",
			"\t\ttry container.encode(rawValue)",
			"\t}",
			"}",
		];
		return new Declaration(name, lines);
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

	union(name: string, members: Schema[], schema: Schema): Declaration {
		const tagged = this.discriminator(members);
		return tagged
			? this.taggedUnion(name, members, tagged, schema)
			: this.untaggedUnion(name, members, schema);
	}

	private taggedUnion(
		name: string,
		members: Schema[],
		tagged: { property: string; valuesByMember: string[][] },
		schema: Schema,
	): Declaration {
		const declaration = new Declaration(name);
		const cases = members.map((member, index) => {
			const values = tagged.valuesByMember[index] ?? [];
			const caseName = camelCase(values.join(" or ")) || `case${index}`;
			const type = this.typeOf(member, pascalCase(caseName), declaration);
			return { caseName, type, values };
		});
		const unknownCase = cases.some((entry) => entry.caseName === "unknown")
			? "unrecognized"
			: "unknown";
		const key = swiftString(tagged.property);
		declaration.lines.push(
			...docComment(schema.description, ""),
			`enum ${name}: Codable, Hashable, Sendable {`,
			...cases.map((entry) => `\tcase ${identifier(entry.caseName)}(${entry.type})`),
			`\t/// A kind from a newer server than this app knows, by its \`${tagged.property}\`.`,
			`\tcase ${unknownCase}(String)`,
			"",
			"\tinit(from decoder: any Decoder) throws {",
			`\t\tlet tag = try decoder.container(keyedBy: AnyCodingKey.self).decode(String.self, forKey: AnyCodingKey(${key}))`,
			"\t\tswitch tag {",
			...cases.map(
				(entry) =>
					`\t\tcase ${entry.values.map(swiftString).join(", ")}: self = .${identifier(entry.caseName)}(try ${entry.type}(from: decoder))`,
			),
			`\t\tdefault: self = .${unknownCase}(tag)`,
			"\t\t}",
			"\t}",
			"",
			"\tfunc encode(to encoder: any Encoder) throws {",
			"\t\tswitch self {",
			...cases.map(
				(entry) =>
					`\t\tcase let .${identifier(entry.caseName)}(value): try value.encode(to: encoder)`,
			),
			`\t\tcase let .${unknownCase}(tag):`,
			`\t\t\tthrow EncodingError.invalidValue(tag, .init(codingPath: encoder.codingPath, debugDescription: "A kind this app doesn't know can't be sent."))`,
			"\t\t}",
			"\t}",
			"}",
		);
		return declaration;
	}

	/** A union whose members share no tag: each is tried in turn, the one with the most required fields first. */
	private untaggedUnion(name: string, members: Schema[], schema: Schema): Declaration {
		const declaration = new Declaration(name);
		const cases = members.map((member, index) => {
			const resolved = this.resolve(member);
			const values = stringValues(resolved);
			const [onlyValue] = values ?? [];
			if (values?.length === 1 && onlyValue !== undefined && !member.$ref) {
				return {
					caseName: camelCase(onlyValue) || `case${index}`,
					literal: onlyValue,
					type: undefined,
					weight: 1000,
				};
			}
			const reference =
				typeof member.$ref === "string" ? member.$ref.slice(componentPrefix.length) : undefined;
			const caseName = reference
				? camelCase(reference)
				: ((
						{
							integer: "integer",
							number: "number",
							string: "string",
							boolean: "bool",
							array: "array",
						} as Record<string, string>
					)[String(resolved.type)] ??
					literalField(resolved) ??
					`variant${index + 1}`);
			const type = this.typeOf(member, pascalCase(caseName), declaration);
			const required = Array.isArray(resolved.required) ? resolved.required.length : 0;
			return {
				caseName,
				literal: undefined,
				type,
				weight: resolved.type === "object" ? 100 + required : 0,
			};
		});
		const attempts = [...cases].sort((a, b) => b.weight - a.weight);
		declaration.lines.push(
			...docComment(schema.description, ""),
			`enum ${name}: Codable, Hashable, Sendable {`,
			...cases.map((entry) =>
				entry.type
					? `\tcase ${identifier(entry.caseName)}(${entry.type})`
					: `\tcase ${identifier(entry.caseName)}`,
			),
			"",
			"\tinit(from decoder: any Decoder) throws {",
			...attempts.flatMap((entry) =>
				entry.type
					? [
							`\t\tif let value = try? ${entry.type}(from: decoder) { self = .${identifier(entry.caseName)}(value); return }`,
						]
					: [
							`\t\tif (try? decoder.singleValueContainer().decode(String.self)) == ${swiftString(entry.literal ?? "")} { self = .${identifier(entry.caseName)}; return }`,
						],
			),
			`\t\tthrow DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "None of ${name}'s kinds."))`,
			"\t}",
			"",
			"\tfunc encode(to encoder: any Encoder) throws {",
			"\t\tswitch self {",
			...cases.map((entry) =>
				entry.type
					? `\t\tcase let .${identifier(entry.caseName)}(value): try value.encode(to: encoder)`
					: `\t\tcase .${identifier(entry.caseName)}:\n\t\t\tvar container = encoder.singleValueContainer()\n\t\t\ttry container.encode(${swiftString(entry.literal ?? "")})`,
			),
			"\t\t}",
			"\t}",
			"}",
		);
		return declaration;
	}

	/**
	 * Builds a declaration, giving its nested types the names they want unless
	 * that hides one of the API's types the declaration refers to; then it builds
	 * it again with those names kept clear.
	 */
	withoutHiding(build: () => Declaration): Declaration {
		this.hiddenNames = new Set();
		for (;;) {
			this.referencedNames = new Set();
			const declaration = build();
			const nestedNames = declaration.allNestedNames();
			const hidden = [...this.referencedNames].filter(
				(name) => nestedNames.has(name) && !this.hiddenNames.has(name),
			);
			if (hidden.length === 0) return declaration;
			for (const name of hidden) this.hiddenNames.add(name);
		}
	}

	/** The declarations written for the API's named schemas, by their Swift names. */
	readonly written = new Map<string, Declaration>();

	/** The declaration for a named schema. */
	component(name: string, schema: Schema): Declaration {
		const declaration = this.withoutHiding(() => this.componentDeclaration(name, schema));
		this.written.set(declaration.name, declaration);
		return declaration;
	}

	private componentDeclaration(name: string, givenSchema: Schema): Declaration {
		const schema = nullableMember(givenSchema) ?? givenSchema;
		this.writingSentType = this.sentSchemas.has(name);
		const swiftName = pascalCase(name);
		if (schema.anyOf || schema.oneOf) {
			const { members, nullable } = unionMembers(schema);
			if (!nullable) {
				const strings = members.map(stringValues);
				if (
					strings.every((values) => values !== undefined) &&
					members.every((member) => !member.$ref)
				) {
					return this.stringEnum(swiftName, [...new Set(strings.flat() as string[])], schema);
				}
				return this.union(swiftName, members, schema);
			}
		}
		const values = stringValues(schema);
		if (values && values.length > 1) return this.stringEnum(swiftName, values, schema);
		if (schema.type === "object" && isObject(schema.properties))
			return this.struct(swiftName, schema);
		// Anything else, such as a nullable union, is an alias of the type it spells.
		const declaration = new Declaration(swiftName);
		const type = this.typeOf(schema, `${swiftName}Value`, declaration);
		declaration.lines.push(
			...docComment(schema.description, ""),
			`typealias ${swiftName} = ${type}`,
		);
		return declaration;
	}

	// MARK: Requests

	requests(): string[] {
		const groups = new Map<string, { path: string; method: string; operation: Operation }[]>();
		for (const [path, operations] of Object.entries(this.document.paths)) {
			for (const [method, operation] of Object.entries(operations)) {
				const group = operation.operationId.includes(".")
					? (operation.operationId.split(".")[0] ?? "")
					: "";
				groups.set(group, [...(groups.get(group) ?? []), { path, method, operation }]);
			}
		}
		const lines: string[] = [];
		for (const [group, operations] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
			let methods: string[] = [];
			const declaration = this.withoutHiding(() => {
				const routes = new Declaration(group ? `${pascalCase(group)}Routes` : "APIClient");
				methods = operations.flatMap(({ path, method, operation }) =>
					this.request(path, method, operation, routes),
				);
				return routes;
			});
			if (methods.length === 0) continue;
			lines.push("");
			if (!group) {
				lines.push(
					"extension APIClient {",
					...methods.map((line) => line.replace("client.call", "call")),
					"}",
				);
				for (const nested of declaration.nested) lines.push("", ...nested.render());
				continue;
			}
			const typeName = `${pascalCase(group)}Routes`;
			lines.push(
				"extension APIClient {",
				`\tvar ${camelCase(group)}: ${typeName} { ${typeName}(client: self) }`,
				"",
				`\t/// The \`${group}\` routes, as \`api.${group}\` in the web's client.`,
				`\tstruct ${typeName}: Sendable {`,
				"\t\tlet client: APIClient",
				...methods.map((line) => (line ? `\t${line}` : line)),
				...declaration.nested.flatMap((nested) => ["", ...nested.render("\t\t")]),
				"\t}",
				"}",
			);
		}
		return lines;
	}

	private request(
		path: string,
		method: string,
		operation: Operation,
		owner: Declaration,
	): string[] {
		const success = Object.entries(operation.responses)
			.filter(([status]) => status.startsWith("2"))
			.sort(([a], [b]) => a.localeCompare(b))[0]?.[1];
		if (success?.content?.[streamContentType]) return [];
		const endpoint = operation.operationId.split(".").pop() ?? operation.operationId;
		const name = camelCase(endpoint);
		const hint = pascalCase(endpoint);

		this.writingSentType = false;
		const parameters: string[] = [];
		const pathParameters = (operation.parameters ?? []).filter(
			(parameter) => parameter.in === "path",
		);
		const queryParameters = (operation.parameters ?? []).filter(
			(parameter) => parameter.in === "query",
		);
		const taken = new Set<string>();
		for (const parameter of pathParameters) {
			const type = this.typeOf(
				parameter.schema,
				`${hint}${pascalCase(parameter.name)}`,
				owner,
			).replace(/\?$/, "");
			parameters.push(`${identifier(camelCase(parameter.name))}: ${type}`);
			taken.add(camelCase(parameter.name));
		}
		const query: string[] = [];
		for (const parameter of queryParameters) {
			const swiftName = camelCase(parameter.name);
			let type = this.typeOf(parameter.schema, `${hint}${pascalCase(parameter.name)}`, owner);
			if (!parameter.required && !type.endsWith("?")) type = `${type}?`;
			parameters.push(`${identifier(swiftName)}: ${type}${type.endsWith("?") ? " = nil" : ""}`);
			taken.add(swiftName);
			query.push(`\t\tquery.add(${swiftString(parameter.name)}, ${identifier(swiftName)})`);
		}

		const body = this.requestBody(operation, hint, owner, taken);
		parameters.push(...body.parameters);

		this.writingSentType = false;
		const json = success?.content?.["application/json"]?.schema;
		const binary = success?.content?.["application/octet-stream"];
		const returns = json
			? this.typeOf(json, `${hint}Response`, owner)
			: binary
				? "Data"
				: undefined;
		const swiftPath = path
			.replace(/^\//, "")
			.replace(/\{([^}]+)\}/g, (_, parameter: string) => `\\(${identifier(camelCase(parameter))})`);

		const lines = [
			"",
			...docComment(operation.description ?? operation.summary, "\t"),
			`\tfunc ${identifier(name)}(${parameters.join(", ")}) async throws${returns ? ` -> ${returns}` : ""} {`,
		];
		const queryArgument = query.length > 0 ? "query.items" : "[]";
		if (query.length > 0) lines.push("\t\tvar query = QueryItems()", ...query);
		lines.push(...body.setup);
		const call = `client.call(${swiftString(method.toUpperCase())}, "${swiftPath}", query: ${queryArgument}${body.argument})`;
		if (returns === "Data")
			lines.push(`\t\treturn try await ${call.replace("client.call(", "client.callForData(")}`);
		else
			lines.push(
				returns
					? `\t\treturn try await ${call}`
					: `\t\t_ = try await ${call.replace("client.call(", "client.callForData(")}`,
			);
		lines.push("\t}");
		return lines;
	}

	/**
	 * How a request's body is taken: an object's fields as the method's own
	 * arguments, so a call reads `update(podId:name:)`; anything else whole.
	 */
	private requestBody(
		operation: Operation,
		hint: string,
		owner: Declaration,
		taken: Set<string>,
	): { parameters: string[]; setup: string[]; argument: string } {
		const content = operation.requestBody?.content ?? {};
		if (content["application/octet-stream"]) {
			return { parameters: ["data: Data"], setup: [], argument: ", data: data" };
		}
		const schema = content["application/json"]?.schema;
		if (!schema) return { parameters: [], setup: [], argument: "" };
		this.writingSentType = true;
		const type = this.typeOf(schema, `${hint}Body`, owner);
		const body = this.declarationNamed(type, owner);
		const fields = body?.properties;
		const collides = fields?.some((field) => taken.has(field.swiftName));
		if (!body || !fields || collides) {
			return { parameters: [`body: ${type}`], setup: [], argument: ", body: body" };
		}
		const arguments_ = fields.filter((field) => field.literal === undefined);
		// Each field's type as the body's declaration spells it, qualified where it's nested there.
		const nestedNames = new Set(body.nested.map((declaration) => declaration.name));
		const qualify = (fieldType: string) =>
			fieldType.replace(/\b[A-Z][A-Za-z0-9_]*\b/g, (name) =>
				nestedNames.has(name) ? `${type}.${name}` : name,
			);
		return {
			parameters: arguments_.map(
				(field) =>
					`${identifier(field.swiftName)}: ${qualify(field.type)}${field.type.endsWith("?") ? " = nil" : ""}`,
			),
			setup: [],
			argument: `, body: ${type}(${arguments_.map((field) => `${field.swiftName}: ${identifier(field.swiftName)}`).join(", ")})`,
		};
	}

	/** The struct called `type`: one nested in `owner`, or one of the API's own. */
	private declarationNamed(type: string, owner: Declaration): Declaration | undefined {
		return owner.nested.find((declaration) => declaration.name === type) ?? this.written.get(type);
	}
}

export function swiftApi(api: OpenApiDocument): string {
	const generator = new Generator(api);
	const components = Object.entries(api.components.schemas)
		.sort(([a], [b]) => a.localeCompare(b))
		.flatMap(([name, schema]) => ["", ...generator.component(name, schema).render()]);
	return [
		"// Generated by apps/ios/scripts/generate-api.ts from packages/contracts/openapi.json. Don't edit it by hand.",
		"// swiftlint:disable all",
		"",
		"import Foundation",
		"",
		"// MARK: Schemas",
		...components,
		"",
		"// MARK: Requests",
		...generator.requests(),
		"",
	].join("\n");
}

export function generate(): GeneratedFiles {
	return {
		files: new Map([
			["Sugabots/API/API.generated.swift", swiftApi(document as unknown as OpenApiDocument)],
		]),
	};
}
