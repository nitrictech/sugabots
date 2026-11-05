/**
 * Writes the API model as Swift: a `Codable` type for each of the API's types,
 * and a typed request for each route, grouped as the web's client groups them,
 * so `api.threads.get(...)` in TypeScript is `client.threads.get(...)` in Swift.
 *
 * It is written against `Sugabots/API/APISupport.swift`: `APIClient.call`,
 * `QueryItems`, `ParameterValue`, `pathSegment`, `Omittable`, `AnyCodingKey`
 * and `JSONValue`.
 *
 * - A struct is a `struct`. A field that may be left out is optional, and a
 *   clearable one is an `Omittable`, which tells left out from null.
 * - An enum or a tagged union reads a value it doesn't know as its unknown case.
 * - A number that may come as `Infinity`, `-Infinity` or `NaN` is a `Double`:
 *   `APIClient`'s decoder and encoder read and write those strings for any.
 */
import type {
	ApiModel,
	Definition,
	Operation,
	OperationGroup,
	Presence,
	Property,
	StringEnum,
	Struct,
	TaggedUnion,
	TypeRef,
	UntaggedUnion,
} from "./model.ts";
import { operationTypes, routesClassName } from "./model.ts";
import { camelCase } from "./naming.ts";

const swiftKeywords = new Set(
	`associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private precedencegroup protocol public rethrows static struct subscript typealias var break case catch continue default defer do else fallthrough for guard if in repeat return throw switch where while as Any false is nil self Self super throws true try Type Protocol`.split(
		" ",
	),
);

/** A name as Swift will take it: backquoted when it's a keyword. */
function identifier(name: string): string {
	return swiftKeywords.has(name) ? `\`${name}\`` : name;
}

const swiftString = (value: string) => JSON.stringify(value);

function docComment(text: string | undefined, indent: string): string[] {
	if (text === undefined || text.trim() === "") return [];
	return text
		.trim()
		.split("\n")
		.map((line) => `${indent}/// ${line.trim()}`.trimEnd());
}

function indented(lines: string[], depth = 1): string[] {
	const prefix = "\t".repeat(depth);
	return lines.map((line) => (line ? prefix + line : line));
}

/** Declarations, a blank line before each. */
function spaced(blocks: string[][]): string[] {
	return blocks.flatMap((lines) => ["", ...lines]);
}

/** A field's type as a struct declares it, given its type without null, `base`. */
function fieldType(presence: Presence, base: string): string {
	switch (presence.kind) {
		case "clearable":
			return `Omittable<${base}>`;
		case "required":
		case "fixed":
			return base;
		case "requiredOrNull":
		case "optional":
			return `${base}?`;
	}
}

/** What a field defaults to, as Swift writes it after the type: in a struct and as a call's argument. */
function fieldDefault(presence: Presence): string {
	switch (presence.kind) {
		case "clearable":
			return " = .omitted";
		case "fixed":
			return ` = ${typeof presence.value === "string" ? swiftString(presence.value) : presence.value}`;
		case "required":
			return "";
		case "requiredOrNull":
		case "optional":
			return " = nil";
	}
}

/** Writes each definition with the types the model nests in it inside it. */
class SwiftWriter {
	/** The Swift type for `type`, with `inlinePrefix` before an inline type's name. */
	typeOf(type: TypeRef, inlinePrefix = ""): string {
		switch (type.kind) {
			case "reference":
				return type.name;
			case "nullable":
				return `${this.typeOf(type.type, inlinePrefix)}?`;
			case "inline":
				return inlinePrefix + type.definition.name;
			case "array":
				return `[${this.typeOf(type.items, inlinePrefix)}]`;
			case "map":
				return `[String: ${this.typeOf(type.values, inlinePrefix)}]`;
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

	/** `definition`'s declaration, with the declarations of the types nested in it. */
	definition(definition: Definition): string[] {
		switch (definition.kind) {
			case "struct":
				return this.struct(definition);
			case "enum":
				return this.stringEnum(definition);
			case "taggedUnion":
				return this.taggedUnion(definition);
			case "untaggedUnion":
				return this.untaggedUnion(definition);
			case "alias":
				// A type alias can't hold types, so what it names sits beside it.
				return [
					...docComment(definition.description, ""),
					`typealias ${definition.name} = ${this.typeOf(definition.type)}`,
					...spaced(this.nestedIn(definition.type)),
				];
		}
	}

	/** The declarations of the inline types `type` uses. */
	nestedIn(type: TypeRef): string[][] {
		switch (type.kind) {
			case "inline":
				return [this.definition(type.definition)];
			case "nullable":
				return this.nestedIn(type.type);
			case "array":
				return this.nestedIn(type.items);
			case "map":
				return this.nestedIn(type.values);
			default:
				return [];
		}
	}

	/** A type's body closed with the declarations nested in it, which the inline types of `types` are. */
	private closed(types: TypeRef[]): string[] {
		return [...indented(spaced(types.flatMap((type) => this.nestedIn(type)))), "}"];
	}

	// MARK: Structs

	private struct(struct: Struct): string[] {
		const properties = struct.properties;
		const lines = [
			...docComment(struct.description, ""),
			`struct ${struct.name}: Codable, Hashable, Sendable {`,
		];
		for (const property of properties) {
			lines.push(...docComment(property.description, "\t"));
			const type = fieldType(property.presence, this.typeOf(property.type));
			lines.push(
				`\tvar ${identifier(property.name)}: ${type}${this.structDefault(property.presence)}`,
			);
		}
		const needsCodingKeys = properties.some(
			(property) =>
				property.name !== property.jsonName || property.presence.kind === "requiredOrNull",
		);
		if (needsCodingKeys) lines.push("", ...this.codingKeys(properties));
		return [...lines, ...this.closed(properties.map((property) => property.type))];
	}

	/** What a struct's field defaults to: a field that may be left out defaults to nil without saying so. */
	private structDefault(presence: Presence): string {
		return presence.kind === "optional" || presence.kind === "requiredOrNull"
			? ""
			: fieldDefault(presence);
	}

	/** Keys for a struct whose names differ from the JSON's, or which must write a null rather than leave it out. */
	private codingKeys(properties: Property[]): string[] {
		const lines = ["\tprivate enum CodingKeys: String, CodingKey {"];
		for (const property of properties) {
			const name = identifier(property.name);
			lines.push(
				property.name === property.jsonName
					? `\t\tcase ${name}`
					: `\t\tcase ${name} = ${swiftString(property.jsonName)}`,
			);
		}
		lines.push("\t}");
		if (!properties.some((property) => property.presence.kind === "requiredOrNull")) return lines;
		// A required field that may be null must be sent as null, which the synthesized encoding leaves out.
		lines.push("", "\tfunc encode(to encoder: any Encoder) throws {");
		lines.push("\t\tvar container = encoder.container(keyedBy: CodingKeys.self)");
		for (const property of properties) {
			const name = identifier(property.name);
			const method = property.presence.kind === "optional" ? "encodeIfPresent" : "encode";
			lines.push(`\t\ttry container.${method}(${name}, forKey: .${name})`);
		}
		lines.push("\t}");
		return lines;
	}

	// MARK: Enums

	private stringEnum(stringEnum: StringEnum): string[] {
		const cases = stringEnum.cases.map((entry) => ({
			value: entry.value,
			name: identifier(entry.label),
		}));
		const unknownCase = identifier(stringEnum.unknownLabel);
		return [
			...docComment(stringEnum.description, ""),
			`enum ${stringEnum.name}: RawRepresentable, Codable, Hashable, Sendable, ParameterValue {`,
			...cases.map((entry) => `\tcase ${entry.name}`),
			"\t/// A value from a newer server than this app knows.",
			`\tcase ${unknownCase}(String)`,
			"",
			"\t/// Every value this app knows.",
			`\tstatic let known: [Self] = [${cases.map((entry) => `.${entry.name}`).join(", ")}]`,
			"",
			"\tinit(rawValue: String) {",
			"\t\tswitch rawValue {",
			...cases.map((entry) => `\t\tcase ${swiftString(entry.value)}: self = .${entry.name}`),
			`\t\tdefault: self = .${unknownCase}(rawValue)`,
			"\t\t}",
			"\t}",
			"",
			"\tvar rawValue: String {",
			"\t\tswitch self {",
			...cases.map((entry) => `\t\tcase .${entry.name}: ${swiftString(entry.value)}`),
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
	}

	// MARK: Unions

	private taggedUnion(union: TaggedUnion): string[] {
		const cases = union.cases.map((entry) => ({
			name: identifier(entry.label),
			type: this.typeOf(entry.type),
			values: entry.tagValues,
		}));
		const unknownCase = identifier(union.unknownCase.label);
		const key = swiftString(union.tag);
		return [
			...docComment(union.description, ""),
			`enum ${union.name}: Codable, Hashable, Sendable {`,
			...cases.map((entry) => `\tcase ${entry.name}(${entry.type})`),
			`\t/// A kind from a newer server than this app knows, by its \`${union.tag}\`.`,
			`\tcase ${unknownCase}(String)`,
			"",
			"\tinit(from decoder: any Decoder) throws {",
			`\t\tlet tag = try decoder.container(keyedBy: AnyCodingKey.self).decode(String.self, forKey: AnyCodingKey(${key}))`,
			"\t\tswitch tag {",
			...cases.map(
				(entry) =>
					`\t\tcase ${entry.values.map(swiftString).join(", ")}: self = .${entry.name}(try ${entry.type}(from: decoder))`,
			),
			`\t\tdefault: self = .${unknownCase}(tag)`,
			"\t\t}",
			"\t}",
			"",
			"\tfunc encode(to encoder: any Encoder) throws {",
			"\t\tswitch self {",
			...cases.map((entry) => `\t\tcase let .${entry.name}(value): try value.encode(to: encoder)`),
			`\t\tcase let .${unknownCase}(tag):`,
			`\t\t\tthrow EncodingError.invalidValue(tag, .init(codingPath: encoder.codingPath, debugDescription: "A kind this app doesn't know can't be sent."))`,
			"\t\t}",
			"\t}",
			...this.closed(union.cases.map((entry) => entry.type)),
		];
	}

	/** A union whose members share no tag: each case is tried in turn, in the order the model lists them. */
	private untaggedUnion(union: UntaggedUnion): string[] {
		const cases = union.cases.map((entry) => ({
			name: identifier(entry.label),
			type: entry.type ? this.typeOf(entry.type) : undefined,
			literal: swiftString(entry.literal ?? ""),
		}));
		return [
			...docComment(union.description, ""),
			`enum ${union.name}: Codable, Hashable, Sendable {`,
			...cases.map((entry) =>
				entry.type ? `\tcase ${entry.name}(${entry.type})` : `\tcase ${entry.name}`,
			),
			"",
			"\tinit(from decoder: any Decoder) throws {",
			...cases.map((entry) =>
				entry.type
					? `\t\tif let value = try? ${entry.type}(from: decoder) { self = .${entry.name}(value); return }`
					: `\t\tif (try? decoder.singleValueContainer().decode(String.self)) == ${entry.literal} { self = .${entry.name}; return }`,
			),
			`\t\tthrow DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "None of ${union.name}'s kinds."))`,
			"\t}",
			"",
			"\tfunc encode(to encoder: any Encoder) throws {",
			"\t\tswitch self {",
			...cases.flatMap((entry) =>
				entry.type
					? [`\t\tcase let .${entry.name}(value): try value.encode(to: encoder)`]
					: [
							`\t\tcase .${entry.name}:`,
							"\t\t\tvar container = encoder.singleValueContainer()",
							`\t\t\ttry container.encode(${entry.literal})`,
						],
			),
			"\t\t}",
			"\t}",
			...this.closed(union.cases.flatMap((entry) => (entry.type ? [entry.type] : []))),
		];
	}

	// MARK: Requests

	requests(groups: OperationGroup[]): string[] {
		return groups.flatMap((group) => {
			const nested = group.operations.flatMap((operation) =>
				operationTypes(operation).flatMap((type) => this.nestedIn(type)),
			);
			if (!group.name) {
				const methods = group.operations.flatMap((operation) => this.request(operation, ""));
				return ["", "extension APIClient {", ...methods, ...indented(spaced(nested)), "}"];
			}
			const typeName = routesClassName(group.name);
			const methods = group.operations.flatMap((operation) => this.request(operation, "client."));
			return [
				"",
				"extension APIClient {",
				`\tvar ${camelCase(group.name)}: ${typeName} { ${typeName}(client: self) }`,
				"",
				`\t/// The \`${group.name}\` routes, as \`api.${group.name}\` in the web's client.`,
				`\tstruct ${typeName}: Sendable {`,
				"\t\tlet client: APIClient",
				...indented(methods),
				...indented(spaced(nested), 2),
				"\t}",
				"}",
			];
		});
	}

	/** A route's method, which sends through `receiver`: `client.`, or `` within `APIClient`. */
	private request(operation: Operation, receiver: string): string[] {
		const parameters: string[] = [];
		for (const parameter of operation.pathParameters) {
			parameters.push(`${identifier(parameter.argumentName)}: ${this.typeOf(parameter.type)}`);
		}
		const query: string[] = [];
		for (const parameter of operation.query) {
			const name = identifier(parameter.argumentName);
			const base = this.typeOf(parameter.type);
			parameters.push(parameter.optional ? `${name}: ${base}? = nil` : `${name}: ${base}`);
			query.push(`\t\tquery.add(${swiftString(parameter.name)}, ${name})`);
		}

		const body = this.requestBody(operation);
		parameters.push(...body.parameters);

		const returns =
			operation.response.kind === "json"
				? this.typeOf(operation.response.type)
				: operation.response.kind === "binary"
					? "Data"
					: undefined;
		const swiftPath = operation.path
			.replace(/^\//, "")
			.replace(/\{([^}]+)\}/g, (_, name: string) => {
				const parameter = operation.pathParameters.find((candidate) => candidate.name === name);
				if (!parameter)
					throw new Error(`${operation.path} names {${name}}, which isn't one of its parameters.`);
				return `\\(pathSegment(${identifier(parameter.argumentName)}))`;
			});

		const lines = [
			"",
			...docComment(operation.description, "\t"),
			`\tfunc ${identifier(camelCase(operation.name))}(${parameters.join(", ")}) async throws${returns ? ` -> ${returns}` : ""} {`,
		];
		const queryArgument = query.length > 0 ? "query.items" : "[]";
		if (query.length > 0) lines.push("\t\tvar query = QueryItems()", ...query);
		const callArguments = `${swiftString(operation.method)}, "${swiftPath}", query: ${queryArgument}${body.argument}`;
		if (returns === "Data")
			lines.push(`\t\treturn try await ${receiver}callForData(${callArguments})`);
		else if (returns) lines.push(`\t\treturn try await ${receiver}call(${callArguments})`);
		else lines.push(`\t\t_ = try await ${receiver}callForData(${callArguments})`);
		lines.push("\t}");
		return lines;
	}

	/** How a request's body is taken: the fields the model gives as arguments, so a call reads `update(podId:name:)`, or whole. */
	private requestBody(operation: Operation): { parameters: string[]; argument: string } {
		if (operation.body.kind === "binary") {
			return { parameters: ["data: Data"], argument: ", data: data" };
		}
		if (operation.body.kind === "none") return { parameters: [], argument: "" };
		const type = this.typeOf(operation.body.type);
		const fields = operation.body.fields;
		if (!fields) return { parameters: [`body: ${type}`], argument: ", body: body" };
		// The body's own nested types, named from outside it.
		return {
			parameters: fields.map(
				(field) =>
					`${identifier(field.name)}: ${fieldType(field.presence, this.typeOf(field.type, `${type}.`))}${fieldDefault(field.presence)}`,
			),
			argument: `, body: ${type}(${fields.map((field) => `${field.name}: ${identifier(field.name)}`).join(", ")})`,
		};
	}
}

/** `Sugabots/API/API.generated.swift`'s contents. */
export function swiftApi(model: ApiModel): string {
	const writer = new SwiftWriter();
	return [
		"// Generated by apps/codegen/generate-api.ts from packages/contracts/openapi.json. Don't edit it by hand.",
		"// swiftlint:disable all",
		"",
		"import Foundation",
		"",
		"// MARK: Schemas",
		...spaced(model.components.map((component) => writer.definition(component.definition))),
		"",
		"// MARK: Requests",
		...writer.requests(model.groups),
		"",
	].join("\n");
}
