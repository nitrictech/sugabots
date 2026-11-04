/**
 * Writes the API model as Swift: a `Codable` type for each of the API's types,
 * and a typed request for each route, grouped as the web's client groups them,
 * so `api.threads.get(...)` in TypeScript is `client.threads.get(...)` in Swift.
 *
 * It is written against `Sugabots/API/APISupport.swift`: `APIClient.call`,
 * `QueryItems`, `QueryValue`, `AnyCodingKey` and `JSONValue`.
 */
import type {
	ApiModel,
	Definition,
	Operation,
	OperationGroup,
	StringEnum,
	Struct,
	TaggedUnion,
	TypeRef,
	UntaggedUnion,
} from "./model.ts";
import { camelCase, NestedNames, pascalCase } from "./naming.ts";

const swiftKeywords = new Set(
	`associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private precedencegroup protocol public rethrows static struct subscript typealias var break case catch continue default defer do else fallthrough for guard if in repeat return throw switch where while as Any false is nil self Self super throws true try Type Protocol`.split(
		" ",
	),
);

/** Types a nested type mustn't be named for, since it would hide them from the code around it. */
const standardTypeNames = new Set(
	"Any Array Bool Data Date Decoder Dictionary Double Encoder Error Int None Optional Result Set Some String Type URL UUID Void".split(
		" ",
	),
);

/** A name as Swift will take it: backquoted when it's a keyword. */
function identifier(name: string): string {
	return swiftKeywords.has(name) ? `\`${name}\`` : name;
}

/** A field's or argument's name. */
function memberName(jsonName: string): string {
	return camelCase(jsonName) || "value";
}

const swiftString = (value: string) => JSON.stringify(value);

function docComment(text: string | undefined, indent: string): string[] {
	if (text === undefined || text.trim() === "") return [];
	return text
		.trim()
		.split("\n")
		.map((line) => `${indent}/// ${line.trim()}`.trimEnd());
}

/**
 * A Swift declaration being written: its lines, and the types nested in it,
 * which are the inline types it uses, named for where they appear.
 */
class Declaration {
	readonly nested: Declaration[] = [];
	/** A struct's fields. */
	properties?: SwiftProperty[];
	readonly name: string;
	readonly lines: string[];
	private readonly nestedNames: NestedNames;

	constructor(name: string, isReserved: (name: string) => boolean, lines: string[] = []) {
		this.name = name;
		this.lines = lines;
		this.nestedNames = new NestedNames(name, isReserved);
	}

	/** A name for a nested type, unique here and never one of the API's own, which it would hide. */
	claimName(wanted: string): string {
		return this.nestedNames.claim(wanted);
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
interface SwiftProperty {
	jsonName: string;
	swiftName: string;
	type: string;
	required: boolean;
	nullable: boolean;
	/** A field with one allowed value, as Swift writes it. */
	literal?: string;
	description?: string;
}

class SwiftWriter {
	/**
	 * Names of the API's own types that the declaration being written refers to,
	 * which a type nested in it mustn't take, and those it has referred to so far.
	 */
	private hiddenNames = new Set<string>();
	private referencedNames = new Set<string>();
	/** The declarations written for the API's named types, by their names. */
	private readonly written = new Map<string, Declaration>();

	private readonly isReserved = (name: string) =>
		this.hiddenNames.has(name) || standardTypeNames.has(name);

	private declaration(name: string, lines: string[] = []): Declaration {
		return new Declaration(name, this.isReserved, lines);
	}

	/** The Swift type for `type`. An inline type gets a declaration nested in `owner`. */
	typeOf(type: TypeRef, owner: Declaration): string {
		switch (type.kind) {
			case "reference":
				this.referencedNames.add(type.name);
				return type.name;
			case "nullable":
				return `${this.typeOf(type.type, owner)}?`;
			case "inline": {
				const name = owner.claimName(type.definition.name);
				owner.nested.push(this.definition(type.definition, name));
				return name;
			}
			case "array":
				return `[${this.typeOf(type.items, owner)}]`;
			case "map":
				return `[String: ${this.typeOf(type.values, owner)}]`;
			case "string":
				return "String";
			case "integer":
				return "Int";
			case "number":
				return "Double";
			case "boolean":
				return "Bool";
			case "dateTime":
				return "Date";
			case "binary":
				return "Data";
			case "json":
				return "JSONValue";
		}
	}

	private definition(definition: Definition, name: string): Declaration {
		switch (definition.kind) {
			case "struct":
				return this.struct(definition, name);
			case "enum":
				return this.stringEnum(definition, name);
			case "taggedUnion":
				return this.taggedUnion(definition, name);
			case "untaggedUnion":
				return this.untaggedUnion(definition, name);
			case "alias": {
				const declaration = this.declaration(name);
				const type = this.typeOf(definition.type, declaration);
				declaration.lines.push(
					...docComment(definition.description, ""),
					`typealias ${name} = ${type}`,
				);
				return declaration;
			}
		}
	}

	// MARK: Structs

	private struct(struct: Struct, name: string): Declaration {
		const declaration = this.declaration(name);
		const properties = struct.properties.map((property): SwiftProperty => {
			const base = this.typeOf(property.type, declaration);
			let type = base;
			// A clearable field is left out to keep its value, and sent as null to clear it.
			if (property.clearable) type = `${base}??`;
			else if (!property.required || property.nullable) type = `${base}?`;
			const literal =
				typeof property.fixedValue === "string"
					? swiftString(property.fixedValue)
					: property.fixedValue?.toString();
			return {
				jsonName: property.jsonName,
				swiftName: memberName(property.jsonName),
				type,
				required: property.required,
				nullable: property.nullable,
				literal,
				description: property.description,
			};
		});
		const needsCodingKeys = properties.some(
			(property) =>
				property.swiftName !== property.jsonName || (property.required && property.nullable),
		);
		const lines = [
			...docComment(struct.description, ""),
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

	/** Keys for a struct whose names differ from the JSON's, or which must write a null rather than leave it out. */
	private codingKeys(properties: SwiftProperty[]): string[] {
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

	private stringEnum(stringEnum: StringEnum, name: string): Declaration {
		const cases = stringEnum.values.map((value) => ({ value, name: camelCase(value) || "empty" }));
		const unknownCase = cases.some((entry) => entry.name === "unknown")
			? "unrecognized"
			: "unknown";
		const lines = [
			...docComment(stringEnum.description, ""),
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
		return this.declaration(name, lines);
	}

	// MARK: Unions

	private taggedUnion(union: TaggedUnion, name: string): Declaration {
		const declaration = this.declaration(name);
		const cases = union.cases.map((entry) => ({
			caseName: entry.label,
			type: this.typeOf(entry.type, declaration),
			values: entry.tagValues,
		}));
		const unknownCase = cases.some((entry) => entry.caseName === "unknown")
			? "unrecognized"
			: "unknown";
		const key = swiftString(union.tag);
		declaration.lines.push(
			...docComment(union.description, ""),
			`enum ${name}: Codable, Hashable, Sendable {`,
			...cases.map((entry) => `\tcase ${identifier(entry.caseName)}(${entry.type})`),
			`\t/// A kind from a newer server than this app knows, by its \`${union.tag}\`.`,
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
	private untaggedUnion(union: UntaggedUnion, name: string): Declaration {
		const declaration = this.declaration(name);
		const swiftTypes = new Map(
			union.cases.map((entry) => [
				entry,
				entry.type ? this.typeOf(entry.type, declaration) : undefined,
			]),
		);
		const caseLine = (entry: UntaggedUnion["cases"][number]) => {
			const type = swiftTypes.get(entry);
			return type
				? `\tcase ${identifier(entry.label)}(${type})`
				: `\tcase ${identifier(entry.label)}`;
		};
		declaration.lines.push(
			...docComment(union.description, ""),
			`enum ${name}: Codable, Hashable, Sendable {`,
			...union.cases.map(caseLine),
			"",
			"\tinit(from decoder: any Decoder) throws {",
			...union.decodingOrder.map((entry) => {
				const type = swiftTypes.get(entry);
				return type
					? `\t\tif let value = try? ${type}(from: decoder) { self = .${identifier(entry.label)}(value); return }`
					: `\t\tif (try? decoder.singleValueContainer().decode(String.self)) == ${swiftString(entry.literal ?? "")} { self = .${identifier(entry.label)}; return }`;
			}),
			`\t\tthrow DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "None of ${name}'s kinds."))`,
			"\t}",
			"",
			"\tfunc encode(to encoder: any Encoder) throws {",
			"\t\tswitch self {",
			...union.cases.map((entry) =>
				swiftTypes.get(entry)
					? `\t\tcase let .${identifier(entry.label)}(value): try value.encode(to: encoder)`
					: `\t\tcase .${identifier(entry.label)}:\n\t\t\tvar container = encoder.singleValueContainer()\n\t\t\ttry container.encode(${swiftString(entry.literal ?? "")})`,
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
	private withoutHiding(build: () => Declaration): Declaration {
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

	/** The declaration for one of the API's named types. */
	component(definition: Definition): Declaration {
		const declaration = this.withoutHiding(() => this.definition(definition, definition.name));
		this.written.set(declaration.name, declaration);
		return declaration;
	}

	// MARK: Requests

	requests(groups: OperationGroup[]): string[] {
		const lines: string[] = [];
		for (const group of groups) {
			let methods: string[] = [];
			const declaration = this.withoutHiding(() => {
				const routes = this.declaration(
					group.name ? `${pascalCase(group.name)}Routes` : "APIClient",
				);
				methods = group.operations.flatMap((operation) => this.request(operation, routes));
				return routes;
			});
			lines.push("");
			if (!group.name) {
				lines.push(
					"extension APIClient {",
					...methods.map((line) => line.replace("client.call", "call")),
					"}",
				);
				for (const nested of declaration.nested) lines.push("", ...nested.render());
				continue;
			}
			const typeName = `${pascalCase(group.name)}Routes`;
			lines.push(
				"extension APIClient {",
				`\tvar ${camelCase(group.name)}: ${typeName} { ${typeName}(client: self) }`,
				"",
				`\t/// The \`${group.name}\` routes, as \`api.${group.name}\` in the web's client.`,
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

	private request(operation: Operation, owner: Declaration): string[] {
		const parameters: string[] = [];
		const taken = new Set<string>();
		for (const parameter of operation.pathParameters) {
			const type = this.typeOf(parameter.type, owner);
			parameters.push(`${identifier(camelCase(parameter.name))}: ${type}`);
			taken.add(camelCase(parameter.name));
		}
		const query: string[] = [];
		for (const parameter of operation.query) {
			const swiftName = camelCase(parameter.name);
			const base = this.typeOf(parameter.type, owner);
			const type = parameter.optional ? `${base}?` : base;
			parameters.push(`${identifier(swiftName)}: ${type}${parameter.optional ? " = nil" : ""}`);
			taken.add(swiftName);
			query.push(`\t\tquery.add(${swiftString(parameter.name)}, ${identifier(swiftName)})`);
		}

		const body = this.requestBody(operation, owner, taken);
		parameters.push(...body.parameters);

		const returns =
			operation.response.kind === "json"
				? this.typeOf(operation.response.type, owner)
				: operation.response.kind === "binary"
					? "Data"
					: undefined;
		const swiftPath = operation.path
			.replace(/^\//, "")
			.replace(/\{([^}]+)\}/g, (_, parameter: string) => `\\(${identifier(camelCase(parameter))})`);

		const lines = [
			"",
			...docComment(operation.description, "\t"),
			`\tfunc ${identifier(camelCase(operation.name))}(${parameters.join(", ")}) async throws${returns ? ` -> ${returns}` : ""} {`,
		];
		const queryArgument = query.length > 0 ? "query.items" : "[]";
		if (query.length > 0) lines.push("\t\tvar query = QueryItems()", ...query);
		const call = `client.call(${swiftString(operation.method)}, "${swiftPath}", query: ${queryArgument}${body.argument})`;
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
		owner: Declaration,
		taken: Set<string>,
	): { parameters: string[]; argument: string } {
		if (operation.body.kind === "binary") {
			return { parameters: ["data: Data"], argument: ", data: data" };
		}
		if (operation.body.kind === "none") return { parameters: [], argument: "" };
		const type = this.typeOf(operation.body.type, owner);
		const body = this.declarationNamed(type, owner);
		const fields = body?.properties;
		const collides = fields?.some((field) => taken.has(field.swiftName));
		if (!body || !fields || collides) {
			return { parameters: [`body: ${type}`], argument: ", body: body" };
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
			argument: `, body: ${type}(${arguments_.map((field) => `${field.swiftName}: ${identifier(field.swiftName)}`).join(", ")})`,
		};
	}

	/** The struct called `type`: one nested in `owner`, or one of the API's own. */
	private declarationNamed(type: string, owner: Declaration): Declaration | undefined {
		return owner.nested.find((declaration) => declaration.name === type) ?? this.written.get(type);
	}
}

/** `Sugabots/API/API.generated.swift`'s contents. */
export function swiftApi(model: ApiModel): string {
	const writer = new SwiftWriter();
	const components = model.components.flatMap((component) => [
		"",
		...writer.component(component.definition).render(),
	]);
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
		...writer.requests(model.groups),
		"",
	].join("\n");
}
