/**
 * Writes the API model as Kotlin, in package `ai.sugabots.api`: a
 * kotlinx.serialization type for each of the API's types, and a `suspend`
 * function for each route, grouped as the web's client groups them, so
 * `api.threads.get(...)` in TypeScript is `client.threads.get(...)` in Kotlin.
 *
 * It is written against `ApiSupport.kt` beside it: `ApiCaller`, `QueryItems`,
 * `Omittable`, `OpenEnum` and the serializers there.
 *
 * - A struct is a `data class`. A field that may be left out defaults to null,
 *   and a clearable one is an `Omittable`, which tells left out from null.
 * - An enum is an `enum class` that reads a value it doesn't know as `UNKNOWN`.
 * - A union is a `sealed interface`. A member defined inline implements it; any
 *   other is wrapped in a case of its own. A tagged union reads a tag it doesn't
 *   know as `Unknown`.
 */
import {
	type ApiModel,
	type Definition,
	type Operation,
	type OperationGroup,
	operationTypes,
	type Presence,
	type Property,
	routesClassName,
	type StringEnum,
	type Struct,
	type TaggedCase,
	type TaggedUnion,
	type TypeRef,
	type UntaggedCase,
	type UntaggedUnion,
} from "./model.ts";
import { camelCase, words } from "./naming.ts";

const packageName = "ai.sugabots.api";
const indentUnit = "    ";

const kotlinKeywords = new Set(
	"as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while".split(
		" ",
	),
);

/** A name as Kotlin will take it: backquoted when it's a keyword. */
function identifier(name: string): string {
	return kotlinKeywords.has(name) ? `\`${name}\`` : name;
}

/** A Kotlin string literal: JSON's, with `$` escaped so it isn't a template. */
function kotlinString(value: string): string {
	return JSON.stringify(value).replaceAll("$", "\\$");
}

function docComment(text: string | undefined): string[] {
	if (text === undefined || text.trim() === "") return [];
	// Kotlin comments nest, so a `/*` or `*/` in the text would end the comment early or never.
	const lines = text
		.trim()
		.split("\n")
		.map((line) => line.trim().replaceAll("/*", "/ *").replaceAll("*/", "* /"));
	if (lines.length === 1) return [`/** ${lines[0]} */`];
	return ["/**", ...lines.map((line) => ` * ${line}`.trimEnd()), " */"];
}

function indented(lines: string[], depth = 1): string[] {
	const prefix = indentUnit.repeat(depth);
	return lines.map((line) => (line ? prefix + line : line));
}

/** An enum case's label as a constant's name: `inProgress` → `IN_PROGRESS`. */
function constantName(label: string): string {
	const name = words(label)
		.map((word) => word.toUpperCase())
		.join("_");
	return /^[0-9]/.test(name) ? `_${name}` : name;
}

function isInlineStruct(type: TypeRef): type is { kind: "inline"; definition: Struct } {
	return type.kind === "inline" && type.definition.kind === "struct";
}

/** A Kotlin number literal for `value`, a field's one allowed value, as a `Long` or a `Double`. */
function numberLiteral(value: number, type: TypeRef): string {
	if (type.kind === "integer") {
		if (!Number.isInteger(value))
			throw new Error(`The integer field's fixed value ${value} isn't an integer.`);
		return `${value}L`;
	}
	return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

/**
 * Writes each definition where the model nests it. `enclosing` is how a type
 * nested at that point is reached from the top of the file: `Outer.`, or `` at
 * the top.
 */
class KotlinWriter {
	private readonly model: ApiModel;

	constructor(model: ApiModel) {
		this.model = model;
	}

	// MARK: Types

	/** The Kotlin type for `type`, with `inlinePrefix` before an inline type's name. */
	private typeOf(type: TypeRef, inlinePrefix = ""): string {
		switch (type.kind) {
			case "reference":
				return type.name;
			case "nullable":
				return `${this.typeOf(type.type, inlinePrefix)}?`;
			case "inline":
				return inlinePrefix + type.definition.name;
			case "array":
				return `List<${this.typeOf(type.items, inlinePrefix)}>`;
			case "map":
				return `Map<String, ${this.typeOf(type.values, inlinePrefix)}>`;
			case "string":
				return "String";
			case "integer":
				return "Long";
			case "number":
				return type.acceptsNonFiniteStrings
					? "@Serializable(with = NonFiniteDoubleSerializer::class) Double"
					: "Double";
			case "boolean":
				return "Boolean";
			case "dateTime":
				return "Instant";
			case "binary":
				return "ByteArray";
			case "json":
				return "JsonElement";
		}
	}

	/** The definition a reference names, looking through aliases. */
	private resolve(type: TypeRef): TypeRef {
		if (type.kind !== "reference") return type;
		const definition = this.model.components.find(
			(component) => component.name === type.name,
		)?.definition;
		if (!definition) return type;
		return definition.kind === "alias"
			? this.resolve(definition.type)
			: { kind: "inline", definition };
	}

	/** A path's or query's value as the string the API reads. */
	private text(type: TypeRef, value: string): string {
		const resolved = this.resolve(type);
		switch (resolved.kind) {
			case "string":
				return value;
			case "integer":
			case "number":
			case "boolean":
				return `${value}.toString()`;
			case "dateTime":
				return `formatTimestamp(${value})`;
			case "inline":
				if (resolved.definition.kind === "enum") return `${value}.rawValue`;
				break;
			default:
				break;
		}
		throw new Error(`A ${resolved.kind} can't be sent in a path or query.`);
	}

	// MARK: Definitions

	/**
	 * `definition`'s declaration, and those of the types nested in it, with
	 * `parent` the sealed interface it implements.
	 */
	private definition(definition: Definition, enclosing: string, parent?: string): string[] {
		switch (definition.kind) {
			case "struct":
				return this.struct(definition, enclosing, parent);
			case "enum":
				return this.stringEnum(definition, enclosing);
			case "taggedUnion":
				return this.taggedUnion(definition, enclosing);
			case "untaggedUnion":
				return this.untaggedUnion(definition, enclosing);
			case "alias":
				// A type alias can't hold types, so what it names sits beside it, at the top of the file.
				return [
					...docComment(definition.description),
					`typealias ${definition.name} = ${this.typeOf(definition.type)}`,
					...this.nestedIn(definition.type, "").flatMap((lines) => ["", ...lines]),
				];
		}
	}

	/** The declarations of the inline types `type` uses. */
	private nestedIn(type: TypeRef, enclosing: string): string[][] {
		switch (type.kind) {
			case "inline":
				return [this.definition(type.definition, enclosing)];
			case "nullable":
				return this.nestedIn(type.type, enclosing);
			case "array":
				return this.nestedIn(type.items, enclosing);
			case "map":
				return this.nestedIn(type.values, enclosing);
			default:
				return [];
		}
	}

	/** A class's body: its nested declarations, blank lines between. */
	private body(blocks: string[][]): string[] {
		return blocks.flatMap((lines, index) => (index === 0 ? lines : ["", ...lines]));
	}

	/** The name kotlinx.serialization knows a type by: its path from the package. */
	private serialName(definition: Definition, enclosing: string): string {
		return `${packageName}.${enclosing}${definition.name}`;
	}

	private struct(struct: Struct, enclosing: string, parent?: string): string[] {
		const name = struct.name;
		const inside = `${enclosing}${name}.`;
		const supertype = parent ? ` : ${parent}` : "";
		const nested = this.body(
			struct.properties.flatMap((property) => this.nestedIn(property.type, inside)),
		);
		// A data class needs a field, so one without is a plain class.
		const header =
			struct.properties.length === 0
				? [`class ${name}${supertype}`]
				: [
						`data class ${name}(`,
						...indented(struct.properties.flatMap((property) => this.field(property))),
						`)${supertype}`,
					];
		if (nested.length > 0) header.push(`${header.pop()} {`, ...indented(nested), "}");
		return [...docComment(struct.description), "@Serializable", ...header];
	}

	/** A struct's field, as a constructor's parameter. */
	private field(property: Property): string[] {
		const annotations =
			property.name === property.jsonName
				? []
				: [`@SerialName(${kotlinString(property.jsonName)})`];
		const declaration = `${identifier(property.name)}: ${fieldType(property.presence, this.typeOf(property.type))}`;
		return [
			...docComment(property.description),
			`${[...annotations, this.parameter(property, declaration)].join(" ")},`,
		];
	}

	/** `declaration`, a field's name and type, as a constructor's parameter with its default. */
	private parameter(property: Property, declaration: string): string {
		const presence = property.presence;
		switch (presence.kind) {
			case "clearable":
				return `val ${declaration} = Omittable.Omitted`;
			case "fixed": {
				const fixed =
					typeof presence.value === "string"
						? kotlinString(presence.value)
						: numberLiteral(presence.value, property.type);
				// A field with one allowed value is sent though it's the default.
				return `@EncodeDefault val ${declaration} = ${fixed}`;
			}
			case "requiredOrNull":
				// A required field that may be null is sent as null, where a default is otherwise left out.
				return `@EncodeDefault val ${declaration} = null`;
			case "optional":
				return `val ${declaration} = null`;
			case "required":
				return `val ${declaration}`;
		}
	}

	private stringEnum(stringEnum: StringEnum, enclosing: string): string[] {
		const name = stringEnum.name;
		const unknown = constantName(stringEnum.unknownLabel);
		return [
			...docComment(stringEnum.description),
			`@Serializable(with = ${name}.Serializer::class)`,
			`enum class ${name}(override val rawValue: String) : OpenEnum {`,
			...indented([
				...stringEnum.cases.map(
					(entry) => `${constantName(entry.label)}(${kotlinString(entry.value)}),`,
				),
				"",
				"/** A value from a newer server than this app knows, which can't be sent. */",
				`${unknown}("");`,
				"",
				`object Serializer : OpenEnumSerializer<${name}>(${kotlinString(this.serialName(stringEnum, enclosing))}, entries, ${unknown})`,
			]),
			"}",
		];
	}

	// MARK: Unions

	/** A union's cases: each inline member, which implements it, or a wrapper of a member's value and the types it uses. */
	private unionCases(union: TaggedUnion | UntaggedUnion, enclosing: string): string[][] {
		const inside = `${enclosing}${union.name}.`;
		const cases: (TaggedCase | UntaggedCase)[] = union.cases;
		return cases.flatMap((entry) => {
			if (!entry.type) return [[`data object ${entry.className} : ${union.name}`]];
			if (isInlineStruct(entry.type))
				return [this.struct(entry.type.definition, inside, union.name)];
			return [
				[`data class ${entry.className}(val value: ${this.typeOf(entry.type)}) : ${union.name}`],
				...this.nestedIn(entry.type, inside),
			];
		});
	}

	private taggedUnion(union: TaggedUnion, enclosing: string): string[] {
		const name = union.name;
		const unknown = union.unknownCase.className;
		const decode = union.cases.map((entry) => {
			const tags = entry.tagValues.map(kotlinString).join(", ");
			if (isInlineStruct(entry.type))
				return `${tags} -> json.decodeFromJsonElement<${entry.className}>(element)`;
			return `${tags} -> ${entry.className}(json.decodeFromJsonElement<${this.typeOf(entry.type)}>(element))`;
		});
		const encode = union.cases.map((entry) => {
			if (isInlineStruct(entry.type))
				return `is ${entry.className} -> json.encodeToJsonElement<${entry.className}>(value)`;
			return `is ${entry.className} -> json.encodeToJsonElement<${this.typeOf(entry.type)}>(value.value)`;
		});
		return [
			...docComment(union.description),
			`@Serializable(with = ${name}.Serializer::class)`,
			`sealed interface ${name} {`,
			...indented([
				...this.body(this.unionCases(union, enclosing)),
				"",
				`/** A kind from a newer server than this app knows, by its \`${union.tag}\`, which can't be sent. */`,
				`data class ${unknown}(val tag: String) : ${name}`,
				"",
				`object Serializer : JsonUnionSerializer<${name}>(${kotlinString(this.serialName(union, enclosing))}) {`,
				...indented([
					`override fun decode(element: JsonElement, json: Json): ${name} =`,
					...indented([`when (val tag = tagOf(element, ${kotlinString(union.tag)})) {`]),
					...indented([...decode, `else -> ${unknown}(tag)`], 2),
					...indented(["}"]),
					"",
					`override fun encode(value: ${name}, json: Json): JsonElement =`,
					...indented(["when (value) {"]),
					...indented(
						[
							...encode,
							`is ${unknown} -> throw SerializationException("A kind this app doesn't know can't be sent.")`,
						],
						2,
					),
					...indented(["}"]),
				]),
				"}",
			]),
			"}",
		];
	}

	/** A union whose members share no tag: each is tried in turn, in the order the model lists them. */
	private untaggedUnion(union: UntaggedUnion, enclosing: string): string[] {
		const name = union.name;
		const decode = union.cases.map((entry) => {
			if (!entry.type)
				return `if (element.isString(${kotlinString(entry.literal)})) return ${entry.className}`;
			if (isInlineStruct(entry.type))
				return `json.decodeOrNull<${entry.className}>(element)?.let { return it }`;
			return `json.decodeOrNull<${this.typeOf(entry.type)}>(element)?.let { return ${entry.className}(it) }`;
		});
		const encode = union.cases.map((entry) => {
			if (!entry.type)
				return `is ${entry.className} -> JsonPrimitive(${kotlinString(entry.literal)})`;
			if (isInlineStruct(entry.type))
				return `is ${entry.className} -> json.encodeToJsonElement<${entry.className}>(value)`;
			return `is ${entry.className} -> json.encodeToJsonElement<${this.typeOf(entry.type)}>(value.value)`;
		});
		return [
			...docComment(union.description),
			`@Serializable(with = ${name}.Serializer::class)`,
			`sealed interface ${name} {`,
			...indented([
				...this.body(this.unionCases(union, enclosing)),
				"",
				`object Serializer : JsonUnionSerializer<${name}>(${kotlinString(this.serialName(union, enclosing))}) {`,
				...indented([
					`override fun decode(element: JsonElement, json: Json): ${name} {`,
					...indented([
						...decode,
						`throw SerializationException(${kotlinString(`None of ${name}'s kinds.`)})`,
					]),
					"}",
					"",
					`override fun encode(value: ${name}, json: Json): JsonElement =`,
					...indented(["when (value) {"]),
					...indented(encode, 2),
					...indented(["}"]),
				]),
				"}",
			]),
			"}",
		];
	}

	/** The declaration for one of the API's named types. */
	component(definition: Definition): string[] {
		return this.definition(definition, "");
	}

	// MARK: Requests

	/**
	 * `ApiClient`, with a property for each group of routes, and a class for
	 * each group. The client sends through an `ApiCaller` of its own, which
	 * writes JSON with `ApiJson`, so an `Omittable` left out is never written.
	 */
	client(groups: OperationGroup[]): string[] {
		const named = groups.filter((group) => group.name);
		const ungrouped = groups.find((group) => !group.name);
		const client = [
			"/**",
			" * The API's routes, grouped as the web's client groups them: `api.threads.get(...)`",
			" * there is `client.threads.get(...)` here.",
			" */",
			"class ApiClient(transport: ApiTransport) {",
			...indented(
				this.body([
					["private val caller = ApiCaller(transport, ApiJson)"],
					...named.map((group) => [
						`/** The \`${group.name}\` routes, as \`api.${group.name}\` in the web's client. */`,
						`val ${identifier(camelCase(group.name))}: ${routesClassName(group.name)} = ${routesClassName(group.name)}(caller)`,
					]),
					...(ungrouped ? this.routes(ungrouped, "ApiClient.") : []),
				]),
			),
			"}",
		];
		const routeClasses = named.map((group) => {
			const className = routesClassName(group.name);
			return [
				`/** The \`${group.name}\` routes, as \`api.${group.name}\` in the web's client. */`,
				`class ${className} internal constructor(private val caller: ApiCaller) {`,
				...indented(this.body(this.routes(group, `${className}.`))),
				"}",
			];
		});
		return this.body([client, ...routeClasses]);
	}

	/** A group's functions, then the types they use defined inline. */
	private routes(group: OperationGroup, enclosing: string): string[][] {
		return [
			...group.operations.map((operation) => this.request(operation)),
			...group.operations.flatMap((operation) =>
				operationTypes(operation).flatMap((type) => this.nestedIn(type, enclosing)),
			),
		];
	}

	private request(operation: Operation): string[] {
		const parameters: string[] = [];
		for (const parameter of operation.pathParameters) {
			parameters.push(`${identifier(parameter.argumentName)}: ${this.typeOf(parameter.type)}`);
		}
		const query: string[] = [];
		for (const parameter of operation.query) {
			const base = this.typeOf(parameter.type);
			const name = identifier(parameter.argumentName);
			parameters.push(parameter.optional ? `${name}: ${base}? = null` : `${name}: ${base}`);
			query.push(
				this.queryLine(
					parameter.name,
					name,
					parameter.type,
					parameter.optional,
					parameter.encoding,
				),
			);
		}
		const body = this.requestBody(operation);
		parameters.push(...body.parameters);

		const returns =
			operation.response.kind === "json"
				? this.typeOf(operation.response.type)
				: operation.response.kind === "binary"
					? "ByteArray"
					: undefined;
		const path = operation.path.replace(/^\//, "").replace(/\{([^}]+)\}/g, (_, name: string) => {
			const parameter = operation.pathParameters.find((candidate) => candidate.name === name);
			if (!parameter)
				throw new Error(`${operation.path} names {${name}}, which isn't one of its parameters.`);
			return `\${pathSegment(${this.text(parameter.type, identifier(parameter.argumentName))})}`;
		});
		const callArguments = [
			kotlinString(operation.method),
			`"${path}"`,
			...(query.length > 0 ? ["query"] : []),
			...(body.argument ? [`body = ${body.argument}`] : []),
		].join(", ");
		const call =
			operation.response.kind === "json"
				? `return caller.call(${callArguments})`
				: operation.response.kind === "binary"
					? `return caller.callForData(${callArguments})`
					: `caller.callForData(${callArguments})`;
		return [
			...docComment(operation.description),
			`suspend fun ${identifier(camelCase(operation.name))}(${parameters.join(", ")})${returns ? `: ${returns}` : ""} {`,
			...indented([...(query.length > 0 ? ["val query = QueryItems()", ...query] : []), call]),
			"}",
		];
	}

	private queryLine(
		jsonName: string,
		value: string,
		type: TypeRef,
		optional: boolean,
		encoding: "single" | "repeated",
	): string {
		const name = kotlinString(jsonName);
		if (encoding === "repeated") {
			const items = type.kind === "array" ? type.items : type;
			const each = this.text(items, "it");
			const values = each === "it" ? value : `${value}${optional ? "?" : ""}.map { ${each} }`;
			return `query.addAll(${name}, ${values})`;
		}
		const text = this.text(type, "it");
		if (text === "it") return `query.add(${name}, ${value})`;
		return optional
			? `query.add(${name}, ${value}?.let { ${text} })`
			: `query.add(${name}, ${this.text(type, value)})`;
	}

	/** How a request's body is taken: the fields the model gives as arguments, so a call reads `update(podId, name = ...)`, or whole. */
	private requestBody(operation: Operation): { parameters: string[]; argument?: string } {
		if (operation.body.kind === "binary") {
			return { parameters: ["data: ByteArray"], argument: "ApiRequestBody.Bytes(data)" };
		}
		if (operation.body.kind === "none") return { parameters: [] };
		const type = this.typeOf(operation.body.type);
		const fields = operation.body.fields;
		if (!fields) return { parameters: [`body: ${type}`], argument: "caller.jsonBody(body)" };
		// The body's own nested types, named from outside it.
		const parameters = fields.map((field) => {
			const declared = `${identifier(field.name)}: ${fieldType(field.presence, this.typeOf(field.type, `${type}.`))}`;
			return `${declared}${argumentDefault(field.presence)}`;
		});
		const values = fields
			.map((field) => identifier(field.name))
			.map((name) => `${name} = ${name}`)
			.join(", ");
		return { parameters, argument: `caller.jsonBody(${type}(${values}))` };
	}
}

/** A field's type as a parameter declares it, given its type without null, `base`. */
function fieldType(presence: Presence, base: string): string {
	switch (presence.kind) {
		case "clearable":
			return `Omittable<${base}?>`;
		case "required":
		case "fixed":
			return base;
		case "requiredOrNull":
		case "optional":
			return `${base}?`;
	}
}

/** What a call's argument for a field of a body defaults to, as Kotlin writes it after the type. */
function argumentDefault(presence: Presence): string {
	switch (presence.kind) {
		case "clearable":
			return " = Omittable.Omitted";
		case "required":
		case "fixed":
			return "";
		case "requiredOrNull":
		case "optional":
			return " = null";
	}
}

/** `Api.generated.kt`'s contents. */
export function kotlinApi(model: ApiModel): string {
	const writer = new KotlinWriter(model);
	const declarations = model.components.map((component) => writer.component(component.definition));
	return [
		"// Generated by apps/codegen/generate-api.ts from packages/contracts/openapi.json. Don't edit it by hand.",
		"@file:OptIn(ExperimentalSerializationApi::class)",
		"@file:UseSerializers(InstantSerializer::class)",
		"",
		`package ${packageName}`,
		"",
		"import java.time.Instant",
		"import kotlinx.serialization.EncodeDefault",
		"import kotlinx.serialization.ExperimentalSerializationApi",
		"import kotlinx.serialization.SerialName",
		"import kotlinx.serialization.Serializable",
		"import kotlinx.serialization.SerializationException",
		"import kotlinx.serialization.UseSerializers",
		"import kotlinx.serialization.json.Json",
		"import kotlinx.serialization.json.JsonElement",
		"import kotlinx.serialization.json.JsonPrimitive",
		"import kotlinx.serialization.json.decodeFromJsonElement",
		"import kotlinx.serialization.json.encodeToJsonElement",
		"",
		"// MARK: Schemas",
		...declarations.flatMap((lines) => ["", ...lines]),
		"",
		"// MARK: Requests",
		"",
		...writer.client(model.groups),
		"",
	].join("\n");
}
