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
	bodyStruct,
	type Definition,
	type Operation,
	type OperationGroup,
	type Property,
	type StringEnum,
	type Struct,
	type TaggedCase,
	type TaggedUnion,
	type TypeRef,
	type UntaggedCase,
	type UntaggedUnion,
} from "./model.ts";
import { camelCase, NestedNames, pascalCase, words } from "./naming.ts";

const packageName = "ai.sugabots.api";
const indentUnit = "    ";

const kotlinKeywords = new Set(
	"as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while".split(
		" ",
	),
);

/**
 * Names a nested type mustn't take: the types the generated code names without
 * qualifying them, which a nested type of the same name would hide.
 */
const reservedTypeNames = new Set(
	"Any Array Boolean Byte ByteArray Char Companion Double EncodeDefault Float Instant Int Json JsonElement JsonPrimitive List Long Map Nothing Number Omittable OpenEnum QueryItems Serializable SerialName SerializationException Serializer Set Short String Unit".split(
		" ",
	),
);

/** A name as Kotlin will take it: backquoted when it's a keyword. */
function identifier(name: string): string {
	return kotlinKeywords.has(name) ? `\`${name}\`` : name;
}

/** A field's or argument's name. */
function memberName(jsonName: string): string {
	return camelCase(jsonName) || "value";
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

/** An enum value as a constant's name: `in-progress` → `IN_PROGRESS`. */
function constantName(value: string): string {
	const name = words(value)
		.map((word) => word.toUpperCase())
		.join("_");
	if (!name) return "EMPTY";
	return /^[0-9]/.test(name) ? `_${name}` : name;
}

/**
 * The class a type is nested in, whose nested types' names are kept apart: the
 * names of its nested types, and how a name inside it is written from outside.
 */
interface Scope {
	name: string;
	nested: NestedNames;
	/** What a type nested here is called from the top of the file: `Outer.` here, or `` at the top. */
	prefix: string;
	parent?: Scope;
}

function isInlineStruct(type: TypeRef): type is { kind: "inline"; definition: Struct } {
	return type.kind === "inline" && type.definition.kind === "struct";
}

class KotlinWriter {
	private readonly model: ApiModel;
	/** Each inline type's name, kept unique among the types nested beside it. */
	private readonly names = new Map<Definition, string>();
	/** The scope each type's own nested types are named in. */
	private readonly scopes = new Map<Definition, Scope>();
	/** The class each union case is: its member's type defined inline, or a wrapper around it. */
	private readonly caseNames = new Map<TaggedCase | UntaggedCase, string>();
	/** The case a tagged union reads a tag it doesn't know as. */
	private readonly unknownCases = new Map<TaggedUnion, string>();
	/**
	 * The top of the file, where the types a type alias uses sit beside it, since
	 * an alias can't hold them; they mustn't take a name the file's types have.
	 */
	private readonly topLevel: Scope;

	constructor(model: ApiModel) {
		this.model = model;
		const topLevelNames = new Set([
			...model.components.map((component) => component.name),
			...model.groups.map(routesClassName),
			"ApiClient",
		]);
		this.topLevel = {
			name: "",
			nested: new NestedNames("", (name) => reservedTypeNames.has(name) || topLevelNames.has(name)),
			prefix: "",
		};
	}

	// MARK: Naming

	/** The scope of a class called `name`, nested in `parent` or at the top of the file. */
	private scope(name: string, parent?: Scope): Scope {
		const enclosing = new Set<string>();
		for (let scope = parent; scope; scope = scope.parent) enclosing.add(scope.name);
		const isReserved = (candidate: string) =>
			reservedTypeNames.has(candidate) || enclosing.has(candidate);
		return {
			name,
			nested: new NestedNames(name, isReserved),
			prefix: `${parent?.prefix ?? ""}${name}.`,
			parent,
		};
	}

	/** Names `definition`, called `name`, and every type nested in it; `scope` is where it's nested. */
	private nameDefinition(definition: Definition, name: string, scope: Scope | undefined): void {
		this.names.set(definition, name);
		// A type alias can't hold types, so what it names sits beside it, at the top of the file.
		const own = definition.kind === "alias" ? this.topLevel : this.scope(name, scope);
		this.scopes.set(definition, own);
		switch (definition.kind) {
			case "struct":
				for (const property of definition.properties) this.nameTypes(property.type, own);
				break;
			case "enum":
				break;
			case "taggedUnion":
				for (const entry of definition.cases) this.nameCase(entry, own);
				this.unknownCases.set(definition, own.nested.claim("Unknown"));
				break;
			case "untaggedUnion":
				for (const entry of definition.cases) this.nameCase(entry, own);
				break;
			case "alias":
				this.nameTypes(definition.type, own);
				break;
		}
	}

	/** Names the inline types `type` uses, which are nested in `scope`. */
	private nameTypes(type: TypeRef, scope: Scope): void {
		if (type.kind === "inline") {
			this.nameDefinition(type.definition, scope.nested.claim(type.definition.name), scope);
		} else if (type.kind === "nullable") {
			this.nameTypes(type.type, scope);
		} else if (type.kind === "array") {
			this.nameTypes(type.items, scope);
		} else if (type.kind === "map") {
			this.nameTypes(type.values, scope);
		}
	}

	private nameCase(entry: TaggedCase | UntaggedCase, scope: Scope): void {
		if (entry.type && isInlineStruct(entry.type)) {
			const name = scope.nested.claim(entry.type.definition.name);
			this.nameDefinition(entry.type.definition, name, scope);
			this.caseNames.set(entry, name);
			return;
		}
		this.caseNames.set(entry, scope.nested.claim(pascalCase(entry.label)));
		if (entry.type) this.nameTypes(entry.type, scope);
	}

	// MARK: Types

	/**
	 * The Kotlin type for `type`, written inside `scope`. A named type hidden there
	 * by a nested type of the same name is qualified with the package.
	 */
	private typeOf(type: TypeRef, scope: Scope, inlinePrefix = ""): string {
		switch (type.kind) {
			case "reference":
				return this.isHidden(type.name, scope) ? `${packageName}.${type.name}` : type.name;
			case "nullable":
				return `${this.typeOf(type.type, scope, inlinePrefix)}?`;
			case "inline":
				return inlinePrefix + this.nameOf(type.definition);
			case "array":
				return `List<${this.typeOf(type.items, scope, inlinePrefix)}>`;
			case "map":
				return `Map<String, ${this.typeOf(type.values, scope, inlinePrefix)}>`;
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

	private isHidden(name: string, scope: Scope): boolean {
		for (let current: Scope | undefined = scope; current; current = current.parent) {
			if (current !== this.topLevel && current.nested.has(name)) return true;
		}
		return false;
	}

	private nameOf(definition: Definition): string {
		const name = this.names.get(definition);
		if (name === undefined) throw new Error(`${definition.name} was never named.`);
		return name;
	}

	private scopeOf(definition: Definition): Scope {
		const scope = this.scopes.get(definition);
		if (!scope) throw new Error(`${definition.name} was never named.`);
		return scope;
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

	/** `definition`'s declaration, and those of the types nested in it, with `parent` the sealed interface it implements. */
	private definition(definition: Definition, parent?: string): string[] {
		switch (definition.kind) {
			case "struct":
				return this.struct(definition, parent);
			case "enum":
				return this.stringEnum(definition);
			case "taggedUnion":
				return this.taggedUnion(definition);
			case "untaggedUnion":
				return this.untaggedUnion(definition);
			case "alias": {
				const scope = this.scopeOf(definition);
				return [
					...docComment(definition.description),
					`typealias ${this.nameOf(definition)} = ${this.typeOf(definition.type, scope)}`,
					...this.nestedIn(definition.type, scope).flatMap((lines) => ["", ...lines]),
				];
			}
		}
	}

	/** The declarations of the inline types `type` uses. */
	private nestedIn(type: TypeRef, scope: Scope): string[][] {
		switch (type.kind) {
			case "inline":
				return [this.definition(type.definition)];
			case "nullable":
				return this.nestedIn(type.type, scope);
			case "array":
				return this.nestedIn(type.items, scope);
			case "map":
				return this.nestedIn(type.values, scope);
			default:
				return [];
		}
	}

	/** A class's body: its nested declarations, blank lines between. */
	private body(blocks: string[][]): string[] {
		return blocks.flatMap((lines, index) => (index === 0 ? lines : ["", ...lines]));
	}

	private struct(struct: Struct, parent?: string): string[] {
		const name = this.nameOf(struct);
		const scope = this.scopeOf(struct);
		const supertype = parent ? ` : ${parent}` : "";
		const nested = this.body(
			struct.properties.flatMap((property) => this.nestedIn(property.type, scope)),
		);
		// A data class needs a field, so one without is a plain class.
		const header =
			struct.properties.length === 0
				? [`class ${name}${supertype}`]
				: [
						`data class ${name}(`,
						...indented(struct.properties.flatMap((property) => this.field(property, scope))),
						`)${supertype}`,
					];
		if (nested.length > 0) header.push(`${header.pop()} {`, ...indented(nested), "}");
		return [...docComment(struct.description), "@Serializable", ...header];
	}

	/** A struct's field, as a constructor's parameter. */
	private field(property: Property, scope: Scope): string[] {
		const name = memberName(property.jsonName);
		const annotations =
			name === property.jsonName ? [] : [`@SerialName(${kotlinString(property.jsonName)})`];
		const declaration = `${identifier(name)}: ${this.fieldType(property, (type) => this.typeOf(type, scope))}`;
		const fixed = this.fixedValue(property);
		let parameter: string;
		if (property.clearable) {
			parameter = `val ${declaration} = Omittable.Omitted`;
		} else if (fixed !== undefined) {
			// A field with one allowed value is sent though it's the default.
			parameter = `@EncodeDefault val ${declaration} = ${fixed}`;
		} else if (property.required && property.nullable) {
			// A required field that may be null is sent as null, where a default is otherwise left out.
			parameter = `@EncodeDefault val ${declaration} = null`;
		} else if (!property.required) {
			parameter = `val ${declaration} = null`;
		} else {
			parameter = `val ${declaration}`;
		}
		return [...docComment(property.description), `${[...annotations, parameter].join(" ")},`];
	}

	/** A field's type as a parameter declares it, with `spell` writing its type. */
	private fieldType(property: Property, spell: (type: TypeRef) => string): string {
		const base = spell(property.type);
		if (property.clearable) return `Omittable<${base}?>`;
		return property.required && !property.nullable ? base : `${base}?`;
	}

	private fixedValue(property: Property): string | undefined {
		if (property.fixedValue === undefined) return undefined;
		if (typeof property.fixedValue === "string") return kotlinString(property.fixedValue);
		return property.type.kind === "integer"
			? `${property.fixedValue}L`
			: `${property.fixedValue}.0`;
	}

	private stringEnum(stringEnum: StringEnum): string[] {
		const name = this.nameOf(stringEnum);
		const constants = new NestedNames(name, () => false);
		const entries = stringEnum.values.map((value) => ({
			value,
			constant: constants.claim(constantName(value)),
		}));
		const unknown = constants.claim("UNKNOWN");
		return [
			...docComment(stringEnum.description),
			`@Serializable(with = ${name}.Serializer::class)`,
			`enum class ${name}(override val rawValue: String) : OpenEnum {`,
			...indented([
				...entries.map((entry) => `${entry.constant}(${kotlinString(entry.value)}),`),
				"",
				"/** A value from a newer server than this app knows, which can't be sent. */",
				`${unknown}("");`,
				"",
				`object Serializer : OpenEnumSerializer<${name}>(${kotlinString(this.serialName(stringEnum))}, entries, ${unknown})`,
			]),
			"}",
		];
	}

	private serialName(definition: Definition): string {
		const scope = this.scopeOf(definition);
		return `${packageName}.${scope.prefix.replace(/\.$/, "") || this.nameOf(definition)}`;
	}

	// MARK: Unions

	/** A union's cases: each inline member, which implements it, or a wrapper of a member's value and the types it uses. */
	private unionCases(union: TaggedUnion | UntaggedUnion): string[][] {
		const name = this.nameOf(union);
		const scope = this.scopeOf(union);
		const cases: (TaggedCase | UntaggedCase)[] = union.cases;
		return cases.flatMap((entry) => {
			const caseName = this.caseName(entry);
			if (!entry.type) return [[`data object ${caseName} : ${name}`]];
			if (isInlineStruct(entry.type)) return [this.struct(entry.type.definition, name)];
			return [
				[`data class ${caseName}(val value: ${this.typeOf(entry.type, scope)}) : ${name}`],
				...this.nestedIn(entry.type, scope),
			];
		});
	}

	private caseName(entry: TaggedCase | UntaggedCase): string {
		const name = this.caseNames.get(entry);
		if (name === undefined) throw new Error(`The case ${entry.label} was never named.`);
		return name;
	}

	private taggedUnion(union: TaggedUnion): string[] {
		const name = this.nameOf(union);
		const scope = this.scopeOf(union);
		const unknown = this.unknownCases.get(union) ?? "Unknown";
		const decode = union.cases.map((entry) => {
			const tags = entry.tagValues.map(kotlinString).join(", ");
			const caseName = this.caseName(entry);
			if (isInlineStruct(entry.type))
				return `${tags} -> json.decodeFromJsonElement<${caseName}>(element)`;
			return `${tags} -> ${caseName}(json.decodeFromJsonElement<${this.typeOf(entry.type, scope)}>(element))`;
		});
		const encode = union.cases.map((entry) => {
			const caseName = this.caseName(entry);
			if (isInlineStruct(entry.type))
				return `is ${caseName} -> json.encodeToJsonElement<${caseName}>(value)`;
			return `is ${caseName} -> json.encodeToJsonElement<${this.typeOf(entry.type, scope)}>(value.value)`;
		});
		return [
			...docComment(union.description),
			`@Serializable(with = ${name}.Serializer::class)`,
			`sealed interface ${name} {`,
			...indented([
				...this.body(this.unionCases(union)),
				"",
				`/** A kind from a newer server than this app knows, by its \`${union.tag}\`, which can't be sent. */`,
				`data class ${unknown}(val tag: String) : ${name}`,
				"",
				`object Serializer : JsonUnionSerializer<${name}>(${kotlinString(this.serialName(union))}) {`,
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

	/** A union whose members share no tag: each is tried in turn, the one with the most to match first. */
	private untaggedUnion(union: UntaggedUnion): string[] {
		const name = this.nameOf(union);
		const scope = this.scopeOf(union);
		const decode = union.decodingOrder.map((entry) => {
			const caseName = this.caseName(entry);
			if (!entry.type)
				return `if (element.isString(${kotlinString(entry.literal)})) return ${caseName}`;
			if (isInlineStruct(entry.type))
				return `json.decodeOrNull<${caseName}>(element)?.let { return it }`;
			return `json.decodeOrNull<${this.typeOf(entry.type, scope)}>(element)?.let { return ${caseName}(it) }`;
		});
		const encode = union.cases.map((entry) => {
			const caseName = this.caseName(entry);
			if (!entry.type) return `is ${caseName} -> JsonPrimitive(${kotlinString(entry.literal)})`;
			if (isInlineStruct(entry.type))
				return `is ${caseName} -> json.encodeToJsonElement<${caseName}>(value)`;
			return `is ${caseName} -> json.encodeToJsonElement<${this.typeOf(entry.type, scope)}>(value.value)`;
		});
		return [
			...docComment(union.description),
			`@Serializable(with = ${name}.Serializer::class)`,
			`sealed interface ${name} {`,
			...indented([
				...this.body(this.unionCases(union)),
				"",
				`object Serializer : JsonUnionSerializer<${name}>(${kotlinString(this.serialName(union))}) {`,
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
		this.nameDefinition(definition, definition.name, undefined);
		return this.definition(definition);
	}

	// MARK: Requests

	/** `ApiClient`, with a property for each group of routes, and a class for each group. */
	client(groups: OperationGroup[]): string[] {
		const groupClass = routesClassName;
		const named = groups.filter((group) => group.name);
		const ungrouped = groups.find((group) => !group.name);
		const clientScope = this.scope("ApiClient");
		// A type nested in the client mustn't hide the classes its properties are.
		for (const group of named) clientScope.nested.claim(groupClass(group));
		const client = [
			"/**",
			" * The API's routes, grouped as the web's client groups them: `api.threads.get(...)`",
			" * there is `client.threads.get(...)` here.",
			" */",
			"class ApiClient(transport: ApiTransport, json: Json = ApiJson) : ApiCaller(transport, json) {",
			...indented(
				this.body([
					...named.map((group) => [
						`/** The \`${group.name}\` routes, as \`api.${group.name}\` in the web's client. */`,
						`val ${identifier(camelCase(group.name))}: ${groupClass(group)} = ${groupClass(group)}(this)`,
					]),
					...(ungrouped ? this.routes(ungrouped, "this", clientScope) : []),
				]),
			),
			"}",
		];
		const routeClasses = named.map((group) => {
			const scope = this.scope(groupClass(group));
			return [
				`/** The \`${group.name}\` routes, as \`api.${group.name}\` in the web's client. */`,
				`class ${groupClass(group)} internal constructor(private val client: ApiCaller) {`,
				...indented(this.body(this.routes(group, "client", scope))),
				"}",
			];
		});
		return this.body([client, ...routeClasses]);
	}

	/** A group's functions, then the types they use defined inline. */
	private routes(group: OperationGroup, caller: string, scope: Scope): string[][] {
		for (const operation of group.operations) {
			for (const type of operationTypes(operation)) this.nameTypes(type, scope);
		}
		return [
			...group.operations.map((operation) => this.request(operation, caller, scope)),
			...group.operations.flatMap((operation) =>
				operationTypes(operation).flatMap((type) => this.nestedIn(type, scope)),
			),
		];
	}

	private request(operation: Operation, caller: string, scope: Scope): string[] {
		const parameters: string[] = [];
		const taken = new Set<string>();
		for (const parameter of operation.pathParameters) {
			const name = camelCase(parameter.name);
			parameters.push(`${identifier(name)}: ${this.typeOf(parameter.type, scope)}`);
			taken.add(name);
		}
		const query: string[] = [];
		for (const parameter of operation.query) {
			const name = camelCase(parameter.name);
			const base = this.typeOf(parameter.type, scope);
			parameters.push(
				parameter.optional
					? `${identifier(name)}: ${base}? = null`
					: `${identifier(name)}: ${base}`,
			);
			taken.add(name);
			query.push(
				this.queryLine(
					parameter.name,
					identifier(name),
					parameter.type,
					parameter.optional,
					parameter.encoding,
				),
			);
		}
		const body = this.requestBody(operation, caller, scope, taken);
		parameters.push(...body.parameters);

		const returns =
			operation.response.kind === "json"
				? this.typeOf(operation.response.type, scope)
				: operation.response.kind === "binary"
					? "ByteArray"
					: undefined;
		const path = operation.path.replace(/^\//, "").replace(/\{([^}]+)\}/g, (_, name: string) => {
			const parameter = operation.pathParameters.find((candidate) => candidate.name === name);
			const value = identifier(camelCase(name));
			return `\${pathSegment(${parameter ? this.text(parameter.type, value) : value})}`;
		});
		const callArguments = [
			kotlinString(operation.method),
			`"${path}"`,
			...(query.length > 0 ? ["query"] : []),
			...(body.argument ? [`body = ${body.argument}`] : []),
		].join(", ");
		const call =
			operation.response.kind === "json"
				? `return ${caller}.call(${callArguments})`
				: operation.response.kind === "binary"
					? `return ${caller}.callForData(${callArguments})`
					: `${caller}.callForData(${callArguments})`;
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

	/**
	 * How a request's body is taken: an object's fields as the function's own
	 * arguments, so a call reads `update(podId, name = ...)`; anything else whole.
	 */
	private requestBody(
		operation: Operation,
		caller: string,
		scope: Scope,
		taken: Set<string>,
	): { parameters: string[]; argument?: string } {
		if (operation.body.kind === "binary") {
			return { parameters: ["data: ByteArray"], argument: "ApiRequestBody.Bytes(data)" };
		}
		if (operation.body.kind === "none") return { parameters: [] };
		const type = this.typeOf(operation.body.type, scope);
		const struct = bodyStruct(this.model, operation.body.type);
		const fields = struct?.properties.filter((property) => property.fixedValue === undefined);
		const collides = fields?.some((field) => taken.has(memberName(field.jsonName)));
		if (!struct || !fields || collides) {
			return { parameters: [`body: ${type}`], argument: `${caller}.jsonBody(body)` };
		}
		// The body's own nested types, named from outside it.
		const spell = (fieldType: TypeRef) => this.typeOf(fieldType, scope, `${type}.`);
		const parameters = fields.map((field) => {
			const name = identifier(memberName(field.jsonName));
			const declared = `${name}: ${this.fieldType(field, spell)}`;
			if (field.clearable) return `${declared} = Omittable.Omitted`;
			return field.required && !field.nullable ? declared : `${declared} = null`;
		});
		const values = fields
			.map((field) => identifier(memberName(field.jsonName)))
			.map((name) => `${name} = ${name}`)
			.join(", ");
		return { parameters, argument: `${caller}.jsonBody(${type}(${values}))` };
	}
}

/** The class a group's routes are functions of. */
function routesClassName(group: OperationGroup): string {
	return `${pascalCase(group.name)}Routes`;
}

/** The types an operation names, in the order it names them. */
function operationTypes(operation: Operation): TypeRef[] {
	return [
		...operation.pathParameters.map((parameter) => parameter.type),
		...operation.query.map((parameter) => parameter.type),
		...(operation.body.kind === "json" ? [operation.body.type] : []),
		...(operation.response.kind === "json" ? [operation.response.type] : []),
	];
}

/** `Api.generated.kt`'s contents. */
export function kotlinApi(model: ApiModel): string {
	const writer = new KotlinWriter(model);
	const declarations = model.components.map((component) => writer.component(component.definition));
	return [
		"// Generated by apps/ios/scripts/generate-api.ts from packages/contracts/openapi.json. Don't edit it by hand.",
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
