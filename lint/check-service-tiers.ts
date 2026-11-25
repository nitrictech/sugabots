/**
 * Checks that every service of ours declares its tier and that every layer
 * building one goes through its tier's wrapper (see `packages/core/src/tiers.ts`):
 *
 * - a class extending `Context.Service` declares `declare readonly [Tier]: "process"`
 *   (or `"request"`). The workspace tier is empty on purpose, so `"workspace"` is
 *   refused here too: adding one takes a decision in review.
 * - a layer that builds one of our services (`Layer.effect(Service, make)`,
 *   `Layer.succeed`, `Layer.sync`) or builds a context, discards its services, or
 *   is chosen at boot (`Layer.effectContext`, `Layer.effectDiscard`, `Layer.unwrap`,
 *   `Layer.fromBuild`, ...) is the argument of `processLayer(...)`, or its
 *   `.pipe(processLayer)`. Services from Effect and other libraries have no marker
 *   and count as process tier, so a layer keyed by one is left alone.
 *
 * What a wrapped layer needs and provides is then checked by the compiler; this
 * check makes sure nothing escapes the wrapper. Names are resolved by the
 * TypeScript checker, so an aliased import, a service bound to another name, or
 * a local `Tier` is judged by what it is, not by how it is spelled.
 *
 * Test files and test doubles are not checked. `packages/workflow` is below
 * `packages/contracts` and cannot import the markers, so it is not checked either.
 *
 * `node lint/check-service-tiers.ts` fails if anything is unmarked or unwrapped,
 * listing where.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
	type CallExpression,
	type ClassDeclaration,
	type Expression,
	isCallExpression,
	isClassDeclaration,
	isComputedPropertyName,
	isExpressionWithTypeArguments,
	isHeritageClause,
	isIdentifier,
	isImportDeclaration,
	isImportSpecifier,
	isLiteralTypeNode,
	isNamedImports,
	isPropertyAccessExpression,
	isPropertyDeclaration,
	isStringLiteral,
	isVariableDeclaration,
	type Node,
	type PropertyDeclaration,
	type SourceFile,
	SyntaxKind,
} from "typescript/unstable/ast";
import {
	API,
	type Symbol as CheckedSymbol,
	type Project,
	SymbolFlags,
} from "typescript/unstable/sync";

/** A declaration, named by what it is called and the file that declares it. */
interface Declaration {
	readonly name: string;
	readonly inFile: RegExp;
}

const CONTEXT_SERVICE: Declaration = {
	name: "Service",
	inFile: /\/effect\/(?:dist|src)\/Context\.(?:d\.)?ts$/i,
};
const TIER: Declaration = { name: "Tier", inFile: /\/packages\/contracts\/src\/tiers\.ts$/i };
const PROCESS_LAYER: Declaration = {
	name: "processLayer",
	inFile: /\/packages\/core\/src\/tiers\.ts$/i,
};
const effectLayer = (name: string): Declaration => ({
	name,
	inFile: /\/effect\/(?:dist|src)\/Layer\.(?:d\.)?ts$/i,
});

/** Layer constructors that take the service they build as their first argument. */
const KEYED_LAYER_BUILDERS = ["effect", "succeed", "sync"];
/** Layer constructors that build a context, build nothing, or choose a layer at boot. */
const KEYLESS_LAYER_BUILDERS = [
	"effectContext",
	"succeedContext",
	"syncContext",
	"effectDiscard",
	"unwrap",
	"fromBuild",
	"fromBuildMemo",
];

/** What the file must say for the check to be worth walking it. */
const MENTIONS_LAYERS_OR_SERVICES = /\bLayer\b|\bService\b/;

/** Code the check does not cover: what only tests and test doubles use, and what cannot import the markers. */
const NOT_CHECKED =
	/\.test\.tsx?$|\.test-support\.ts$|\/testing\.ts$|\/test-[\w-]+\.ts$|\/packages\/workflow\/src\//;

/** A service or layer that breaks the tier rules. */
export interface Violation {
	/** The file, from `root`. */
	readonly file: string;
	readonly line: number;
	readonly message: string;
}

export interface Scan {
	/** The repository's root, which files are named from. */
	readonly root: string;
	/** The `tsconfig.json` of each project to scan. */
	readonly tsconfigs: readonly string[];
	/** Whether the check covers a source file, by its absolute path. */
	readonly isChecked: (file: string) => boolean;
}

/** Every first-party package's own sources, except what {@link NOT_CHECKED} leaves out. */
export function repositoryScan(root: string): Scan {
	const packages = join(root, "packages");
	const sources = new RegExp(`^${escapeForPattern(packages)}/[^/]+/src/`);
	return {
		root,
		tsconfigs: readdirSync(packages)
			.map((name) => join(packages, name, "tsconfig.json"))
			.filter(existsSync),
		isChecked: (file) => sources.test(file) && !NOT_CHECKED.test(file),
	};
}

/** Every unmarked service and unwrapped layer in the files `scan` covers. */
export function tierViolations({ root, tsconfigs, isChecked }: Scan): Violation[] {
	const api = new API({ cwd: root });
	try {
		const snapshot = api.updateSnapshot({ openProjects: [...tsconfigs] });
		const violations: Violation[] = [];
		const walked = new Set<string>();
		for (const project of snapshot.getProjects()) {
			for (const file of project.rootFiles) {
				if (!isChecked(file) || walked.has(file)) continue;
				walked.add(file);
				if (!MENTIONS_LAYERS_OR_SERVICES.test(readFileSync(file, "utf8"))) continue;
				violations.push(...new FileCheck(project, file, root).violations());
			}
		}
		return violations;
	} finally {
		api.close();
	}
}

/** One file, walked once. */
class FileCheck {
	readonly #project: Project;
	readonly #source: SourceFile;
	readonly #file: string;
	/** The names the file calls `Context.Service` and the layer constructors by. */
	readonly #calledNames: ReadonlySet<string>;
	readonly #found: Violation[] = [];

	constructor(project: Project, file: string, root: string) {
		this.#project = project;
		this.#file = relative(root, file);
		const source = project.program.getSourceFile(file);
		if (!source) throw new Error(`${file} is not in the program of ${project.configFileName}`);
		this.#source = source;
		this.#calledNames = calledNames(source);
	}

	violations(): Violation[] {
		const visit = (node: Node) => {
			if (isCallExpression(node)) this.#checkCall(node);
			node.forEachChild(visit);
		};
		visit(this.#source);
		return this.#found;
	}

	#report(node: Node, message: string) {
		const line = this.#source.getLineAndCharacterOfPosition(node.getStart(this.#source)).line + 1;
		this.#found.push({ file: this.#file, line, message });
	}

	#checkCall(call: CallExpression) {
		if (!this.#calledNames.has(calleeName(call.expression))) return;
		if (this.#declaredAs(call.expression, CONTEXT_SERVICE)) return this.#checkContextService(call);
		const keyed = KEYED_LAYER_BUILDERS.find((name) =>
			this.#declaredAs(call.expression, effectLayer(name)),
		);
		if (keyed) return this.#checkKeyedLayer(call, keyed);
		const keyless = KEYLESS_LAYER_BUILDERS.find((name) =>
			this.#declaredAs(call.expression, effectLayer(name)),
		);
		if (keyless) this.#requireWrapper(call, `Layer.${keyless}`, "is built once, at boot");
	}

	/** `Context.Service<...>()` is the first call of `class X extends Context.Service<...>()(key)`. */
	#checkContextService(call: CallExpression) {
		const service = serviceClassExtending(call);
		if (!service) {
			return this.#report(
				call,
				"Context.Service is declared as a class, so that it can declare its tier in its body.",
			);
		}
		const name = service.name?.text ?? "(anonymous)";
		const tier = this.#declaredTier(service);
		if (tier === undefined) {
			this.#report(
				service,
				`${name} extends Context.Service without a tier. Declare it in the class body: \`declare readonly [Tier]: "process";\` (or "request" for a service that lives for one call).`,
			);
		} else if (tier === "workspace") {
			this.#report(
				service,
				`${name} declares the workspace tier, which is empty on purpose: services take the workspace as an argument. Adding one takes a decision in review.`,
			);
		} else if (tier !== "process" && tier !== "request") {
			this.#report(service, `${name} declares an unknown tier "${tier}".`);
		}
	}

	#checkKeyedLayer(call: CallExpression, builder: string) {
		const [key, effect] = call.arguments;
		const name = `Layer.${builder}`;
		// `Layer.effect(Service)(make)`: the layer is the call that applies it.
		const curried = effect === undefined;
		const applied = curried && isCallExpression(call.parent) && same(call.parent.expression, call);
		if (curried && !applied) {
			return this.#report(
				call,
				`${name}(Service) is the first half of a layer: apply it at once, ${name}(Service)(make), or pass both, ${name}(Service, make).`,
			);
		}
		if (!key) return;
		const built = this.#serviceBuiltBy(key);
		if (built.kind === "library") return;
		if (built.tier === "request") {
			return this.#report(
				call,
				`${built.name} is request tier: it is provided for one call, not built once by a layer.`,
			);
		}
		this.#requireWrapper(applied ? call.parent : call, name, `builds ${built.name}`);
	}

	#requireWrapper(layer: Node, builder: string, reason: string) {
		if (this.#isWrapped(layer)) return;
		this.#report(
			layer,
			`${builder} ${reason}, so it goes through its tier's wrapper: \`processLayer(${builder}(...))\`, or \`${builder}(...).pipe(processLayer)\`.`,
		);
	}

	/** `processLayer(layer)`, or `layer.pipe(processLayer)` where wrapping would re-indent a long layer. */
	#isWrapped(layer: Node): boolean {
		const parent = layer.parent;
		if (isCallExpression(parent)) {
			const [wrapped] = parent.arguments;
			return (
				wrapped !== undefined &&
				same(wrapped, layer) &&
				this.#declaredAs(parent.expression, PROCESS_LAYER)
			);
		}
		if (!isPropertyAccessExpression(parent) || parent.name.text !== "pipe") return false;
		const pipe = parent.parent;
		if (!isCallExpression(pipe) || !same(pipe.expression, parent)) return false;
		const [first] = pipe.arguments;
		return first !== undefined && this.#declaredAs(first, PROCESS_LAYER);
	}

	/** Whose service a layer keyed by `key` builds: a library's, or one of ours with the tier it declares. */
	#serviceBuiltBy(
		key: Expression,
	): { kind: "library" } | { kind: "ours"; name: string; tier?: string } {
		const declaration = this.#project.checker.getTypeAtLocation(key)?.getSymbol()?.declarations[0];
		if (declaration && /\/node_modules\//.test(declaration.path)) return { kind: "library" };
		const service = declaration?.resolve(this.#project);
		return {
			kind: "ours",
			name: key.getText(this.#source),
			tier: service && isClassDeclaration(service) ? this.#declaredTier(service) : undefined,
		};
	}

	/** The tier in a class's `declare readonly [Tier]: "process"`, or undefined if it has none. */
	#declaredTier(service: ClassDeclaration): string | undefined {
		const marker = service.members.find(
			(member): member is PropertyDeclaration =>
				isPropertyDeclaration(member) &&
				isDeclared(member) &&
				isComputedPropertyName(member.name) &&
				this.#declaredAs(member.name.expression, TIER),
		);
		if (!marker) return undefined;
		const tier = marker.type;
		return tier && isLiteralTypeNode(tier) && isStringLiteral(tier.literal)
			? tier.literal.text
			: "(not a string literal)";
	}

	/** Whether `node` names `wanted`, through any imports, aliases and `const` rebindings. */
	#declaredAs(node: Node, wanted: Declaration): boolean {
		const symbol = this.#resolve(node);
		return (
			symbol?.name === wanted.name && symbol.declarations.some((d) => wanted.inFile.test(d.path))
		);
	}

	#resolve(node: Node, depth = 0): CheckedSymbol | undefined {
		const { checker } = this.#project;
		let symbol = checker.getSymbolAtLocation(isPropertyAccessExpression(node) ? node.name : node);
		if (symbol && symbol.flags & SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
		const rebound = symbol && depth < MAX_REBINDINGS ? this.#reboundTo(symbol) : undefined;
		return (rebound && this.#resolve(rebound, depth + 1)) ?? symbol;
	}

	/** What `const symbol = other` or `const symbol = other.name` rebinds, if it is that. */
	#reboundTo(symbol: CheckedSymbol): Node | undefined {
		const declaration = symbol.valueDeclaration?.resolve(this.#project);
		const initializer =
			declaration && isVariableDeclaration(declaration) ? declaration.initializer : undefined;
		return initializer && (isIdentifier(initializer) || isPropertyAccessExpression(initializer))
			? initializer
			: undefined;
	}
}

const MAX_REBINDINGS = 5;

/** The names a file calls `Context.Service` and the layer constructors by: their own, and any import renames. */
function calledNames(source: SourceFile): ReadonlySet<string> {
	const original = new Set(["Service", ...KEYED_LAYER_BUILDERS, ...KEYLESS_LAYER_BUILDERS]);
	const names = new Set(original);
	for (const statement of source.statements) {
		const bindings = isImportDeclaration(statement)
			? statement.importClause?.namedBindings
			: undefined;
		if (!bindings || !isNamedImports(bindings)) continue;
		for (const specifier of bindings.elements) {
			if (
				isImportSpecifier(specifier) &&
				original.has((specifier.propertyName ?? specifier.name).text)
			) {
				names.add(specifier.name.text);
			}
		}
	}
	return names;
}

/** `Service` in `Context.Service`, or `build` in `build`: the last name a call goes by. */
function calleeName(callee: Expression): string {
	if (isPropertyAccessExpression(callee)) return callee.name.text;
	return isIdentifier(callee) ? callee.text : "";
}

/** The class that `call`, `Context.Service<...>()`, is the first call of in `extends Context.Service<...>()(key)`. */
function serviceClassExtending(call: CallExpression): ClassDeclaration | undefined {
	const withKey = call.parent;
	if (!isCallExpression(withKey) || !same(withKey.expression, call)) return undefined;
	const heritage = withKey.parent;
	const clause = heritage?.parent;
	const declaration = clause?.parent;
	return heritage &&
		isExpressionWithTypeArguments(heritage) &&
		clause &&
		isHeritageClause(clause) &&
		clause.token === SyntaxKind.ExtendsKeyword &&
		declaration &&
		isClassDeclaration(declaration)
		? declaration
		: undefined;
}

function isDeclared(member: PropertyDeclaration): boolean {
	return member.modifiers?.some((modifier) => modifier.kind === SyntaxKind.DeclareKeyword) ?? false;
}

/** Whether two nodes are the same one of a file; nodes are made anew each time they are walked to. */
function same(a: Node, b: Node): boolean {
	return a.kind === b.kind && a.pos === b.pos && a.end === b.end;
}

function escapeForPattern(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (import.meta.main) {
	const root = resolve(import.meta.dirname, "..");
	const violations = tierViolations(repositoryScan(root));
	for (const { file, line, message } of violations) console.error(`${file}:${line}  ${message}`);
	process.exitCode = violations.length > 0 ? 1 : 0;
}
