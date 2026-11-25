/**
 * Checks for imports across package boundaries by name or by resolved path.
 * This best-effort check recognizes static specifiers and fixed glob prefixes.
 *
 * `node lint/check-package-boundaries.ts` fails if any import crosses a
 * boundary, listing where.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type CallExpression, type Node, parseSync, Visitor } from "oxc-parser";

/** A package that must not import another. */
export interface Boundary {
	/** The importing package's directory, from the repository's root. */
	readonly from: string;
	/** The directory of the package it must not reach, from the repository's root. */
	readonly mayNotReach: string;
	/** That package's name, as a bare import names it. */
	readonly packageName: string;
	/** Why, for whoever crossed it. */
	readonly reason: string;
}

export const BOUNDARIES: readonly Boundary[] = [
	{
		from: "packages/core",
		mayNotReach: "packages/bot-loop",
		packageName: "@sugabots/bot-loop",
		reason:
			"Core starts turns without knowing the bot loop: it declares the services that start, steer and interrupt turns, and the server provides them from `@sugabots/bot-loop`.",
	},
];

/** An import that crossed a boundary. */
export interface Violation {
	/** The importing file, from the repository's root. */
	readonly file: string;
	readonly line: number;
	/** The import as written. */
	readonly specifier: string;
	readonly boundary: Boundary;
}

const SOURCE_FILE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;
const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
];
const VITEST_MODULE_METHODS = new Set([
	"mock",
	"doMock",
	"unmock",
	"doUnmock",
	"importActual",
	"importMock",
]);

/** Directories never searched: what package managers and builds write. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", ".turbo"]);

/** Every import under `root` that crosses one of `boundaries`. */
export function boundaryViolations(
	root: string,
	boundaries: readonly Boundary[] = BOUNDARIES,
): Violation[] {
	return boundaries.flatMap((boundary) => {
		const from = join(root, boundary.from);
		if (!existsSync(from)) return [];
		const forbidden = canonical(join(root, boundary.mayNotReach));
		const manifest = join(from, "package.json");
		const declaration = dependencyLine(manifest, boundary.packageName);
		const imports = sourceFiles(from).flatMap((file) =>
			importsOf(file)
				.filter(
					({ specifier, glob }) =>
						reaches(file, specifier, boundary.packageName, forbidden) ||
						(glob &&
							specifier.startsWith("/") &&
							reaches(file, join(root, specifier), boundary.packageName, forbidden)),
				)
				.map(({ specifier, line }) => ({
					file: relative(root, file),
					line,
					specifier,
					boundary,
				})),
		);
		return declaration === undefined
			? imports
			: [
					{
						file: relative(root, manifest),
						line: declaration,
						specifier: boundary.packageName,
						boundary,
					},
					...imports,
				];
	});
}

/** Whether `specifier`, imported by `file`, names the package `packageName` or resolves into `directory`. */
function reaches(file: string, specifier: string, packageName: string, directory: string): boolean {
	if (specifier === packageName || specifier.startsWith(`${packageName}/`)) return true;
	if (!specifier.startsWith(".") && !specifier.startsWith("/")) return false;
	const target = canonical(resolve(dirname(file), specifier));
	return target === directory || target.startsWith(`${directory}${sep}`);
}

/** `path` with its symbolic links followed, as far as it exists. */
function canonical(path: string): string {
	if (existsSync(path)) return realpathSync(path);
	const parent = dirname(path);
	return parent === path ? path : join(canonical(parent), path.slice(parent.length + 1));
}

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(path);
		return entry.isFile() && SOURCE_FILE.test(entry.name) ? [path] : [];
	});
}

function importsOf(file: string): { specifier: string; line: number; glob: boolean }[] {
	const source = readFileSync(file, "utf8");
	const parsed = parseSync(file, source, { preserveParens: false });
	const [error] = parsed.errors;
	if (error) throw new Error(`${file}: ${error.message}`);
	const vitestNames = new Set(["vi", "vitest"]);
	const requireFactories = new Set(["createRequire"]);
	const program = parsed.program;
	for (const statement of program.body) {
		if (statement.type !== "ImportDeclaration") continue;
		const source = statement.source.value;
		for (const specifier of statement.specifiers) {
			if (specifier.type !== "ImportSpecifier" || specifier.imported.type !== "Identifier") {
				continue;
			}
			if (source === "vitest" && vitestNames.has(specifier.imported.name)) {
				vitestNames.add(specifier.local.name);
			}
			if (
				(source === "node:module" || source === "module") &&
				specifier.imported.name === "createRequire"
			) {
				requireFactories.add(specifier.local.name);
			}
		}
	}
	const imports: { specifier: string; line: number; glob: boolean }[] = [];
	const record = (value: Node | null | undefined, start: number, glob = false) => {
		const specifier = moduleName(value);
		if (specifier !== undefined) imports.push({ specifier, line: lineAt(source, start), glob });
	};
	new Visitor({
		ImportDeclaration: (node) => record(node.source, node.start),
		ExportNamedDeclaration: (node) => record(node.source, node.start),
		ExportAllDeclaration: (node) => record(node.source, node.start),
		ImportExpression: (node) => record(node.source, node.start),
		TSImportType: (node) => record(node.source, node.start),
		TSExternalModuleReference: (node) => record(node.expression, node.start),
		CallExpression: (node) => {
			const kind = moduleCallKind(node.callee, vitestNames, requireFactories);
			if (!kind) return;
			const argument = node.arguments[0];
			const glob = kind === "glob";
			const specifiers =
				glob && argument?.type === "ArrayExpression" ? argument.elements : [argument];
			for (const specifier of specifiers) record(specifier, node.start, glob);
		},
	}).visit(program);
	return imports;
}

function moduleName(value: Node | null | undefined): string | undefined {
	if (value?.type === "Literal" && typeof value.value === "string") return value.value;
	if (value?.type !== "TemplateLiteral") return undefined;
	const prefix = value.quasis[0]?.value.cooked;
	return value.expressions.length === 0 || prefix?.endsWith("/")
		? (prefix ?? undefined)
		: undefined;
}

function moduleCallKind(
	callee: CallExpression["callee"],
	vitestNames: ReadonlySet<string>,
	requireFactories: ReadonlySet<string>,
): "single" | "glob" | undefined {
	if (callee.type === "Identifier" && callee.name === "require") return "single";
	if (
		callee.type === "CallExpression" &&
		callee.callee.type === "Identifier" &&
		requireFactories.has(callee.callee.name)
	) {
		return "single";
	}
	if (callee.type !== "MemberExpression") return undefined;
	const { object, property, computed } = callee;
	const method = !computed && property.type === "Identifier" ? property.name : moduleName(property);
	if (method === undefined) return undefined;
	if (
		object.type === "MetaProperty" &&
		object.meta.name === "import" &&
		object.property.name === "meta"
	) {
		if (method === "glob") return "glob";
		if (method === "resolve") return "single";
	}
	if (
		object.type === "Identifier" &&
		((vitestNames.has(object.name) && VITEST_MODULE_METHODS.has(method)) ||
			(object.name === "require" && method === "resolve") ||
			(object.name === "module" && method === "require"))
	)
		return "single";
	return undefined;
}

function dependencyLine(file: string, packageName: string): number | undefined {
	if (!existsSync(file)) return undefined;
	const source = readFileSync(file, "utf8");
	const manifest: Record<string, Record<string, string> | undefined> = JSON.parse(source);
	if (!DEPENDENCY_FIELDS.some((field) => Object.hasOwn(manifest[field] ?? {}, packageName))) {
		return undefined;
	}
	return lineAt(source, source.indexOf(JSON.stringify(packageName)));
}

function lineAt(text: string, offset: number): number {
	return text.slice(0, offset).split("\n").length;
}

if (import.meta.main) {
	const violations = boundaryViolations(resolve(import.meta.dirname, ".."));
	for (const { file, line, specifier, boundary } of violations) {
		const verb = file.endsWith("package.json") ? "declares a dependency on" : "imports";
		console.error(`${file}:${line}  ${verb} "${specifier}". ${boundary.reason}`);
	}
	process.exitCode = violations.length > 0 ? 1 : 0;
}
