import { globSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import {
	type Node,
	type Program,
	parseSync,
	type TSTypeName,
	Visitor,
	visitorKeys,
} from "oxc-parser";

const PROOFS = "packages/core/src/proofs/";
const AUTHENTICATION = "packages/core/src/authentication/";
const DOUBLE_ASSERTION_EXCEPTIONS = new Set([
	`${PROOFS}proof.ts`,
	"packages/core/src/providers/network/egress.ts",
	"packages/core/src/providers/web/readable.ts",
	"packages/core/src/workflows/lanes.ts",
]);

export function declaredProofs(sources: readonly string[]): ReadonlySet<string> {
	const proofs = new Set(["Named", "Proof"]);
	for (const source of sources) {
		new Visitor({
			TSInterfaceDeclaration(node) {
				if (
					node.extends.some(
						({ expression }) => expression.type === "Identifier" && expression.name === "Proof",
					)
				) {
					proofs.add(node.id.name);
				}
			},
		}).visit(parseSync("proof.ts", source).program);
	}
	return proofs;
}

interface ModuleBindings {
	readonly types: Map<string, Node>;
	readonly values: Map<string, Node>;
	readonly imports: Map<string, { source: string; name: string }>;
}

function moduleBindings(program: Program): ModuleBindings {
	const types = new Map<string, Node>();
	const values = new Map<string, Node>();
	const imports = new Map<string, { source: string; name: string }>();
	new Visitor({
		TSTypeAliasDeclaration(node) {
			types.set(node.id.name, node.typeAnnotation);
		},
		TSInterfaceDeclaration(node) {
			types.set(node.id.name, node);
		},
		VariableDeclarator(node) {
			if (node.id.type !== "Identifier") return;
			if (node.init) values.set(node.id.name, node.init);
		},
		Identifier(node) {
			const annotation: unknown = Reflect.get(node, "typeAnnotation");
			if (isNode(annotation) && annotation.type === "TSTypeAnnotation") {
				values.set(node.name, annotation.typeAnnotation);
			}
		},
		FunctionDeclaration(node) {
			if (node.id && node.returnType) values.set(node.id.name, node.returnType.typeAnnotation);
		},
		ImportDeclaration(node) {
			for (const entry of node.specifiers) {
				if (entry.type === "ImportSpecifier") {
					const name =
						entry.imported.type === "Identifier" ? entry.imported.name : entry.imported.value;
					imports.set(entry.local.name, { source: node.source.value, name });
				} else if (entry.type === "ImportNamespaceSpecifier") {
					imports.set(entry.local.name, { source: node.source.value, name: "*" });
				}
			}
		},
		ExportNamedDeclaration(node) {
			if (!node.source) return;
			for (const entry of node.specifiers) {
				const name = entry.local.type === "Identifier" ? entry.local.name : entry.local.value;
				const exported =
					entry.exported.type === "Identifier" ? entry.exported.name : entry.exported.value;
				imports.set(exported, { source: node.source.value, name });
			}
		},
	}).visit(program);
	return { types, values, imports };
}

function resolveImport(
	modules: ReadonlyMap<string, ModuleBindings>,
	file: string,
	specifier: string,
): string | undefined {
	const workspace = /^@sugabots\/([^/]+)(?:\/(.+))?$/.exec(specifier);
	const base = specifier.startsWith(".")
		? posix.join(posix.dirname(file), specifier)
		: workspace && `packages/${workspace[1]}/src/${workspace[2] ?? "index"}`;
	return base
		? [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((candidate) =>
				modules.has(candidate),
			)
		: undefined;
}

function isNode(value: unknown): value is Node {
	return typeof value === "object" && value !== null && "type" in value;
}

function children(node: Node): Node[] {
	return (visitorKeys[node.type] ?? []).flatMap((key) => {
		const value: unknown = Reflect.get(node, key);
		return Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : [];
	});
}

function containsProof(
	file: string,
	type: Node,
	proofs: ReadonlySet<string>,
	modules: ReadonlyMap<string, ModuleBindings>,
): boolean {
	const seen = new Set<string>();
	const reference = (file: string, name: string, kind: "types" | "values"): boolean => {
		if (kind === "types" && proofs.has(name)) return true;
		if (
			kind === "values" &&
			file.startsWith(PROOFS) &&
			name.startsWith("prove") &&
			proofs.has(name.slice(5))
		)
			return true;
		const binding = `${file}:${kind}:${name}`;
		if (seen.has(binding)) return false;
		seen.add(binding);
		const module = modules.get(file);
		const declaration = module?.[kind].get(name);
		if (declaration) return kind === "types" ? walk(file, declaration) : value(file, declaration);
		const imported = module?.imports.get(name);
		if (kind === "types" && imported && proofs.has(imported.name)) return true;
		const origin = imported && resolveImport(modules, file, imported.source);
		return origin && imported ? reference(origin, imported.name, kind) : false;
	};
	const qualified = (file: string, name: TSTypeName, kind: "types" | "values"): boolean => {
		if (name.type === "Identifier") return reference(file, name.name, kind);
		if (name.type !== "TSQualifiedName") return false;
		const imported =
			name.left.type === "Identifier" && modules.get(file)?.imports.get(name.left.name);
		const origin =
			imported && imported.name === "*" && resolveImport(modules, file, imported.source);
		return reference(origin || file, name.right.name, kind);
	};
	const value = (file: string, node: Node): boolean => {
		switch (node.type) {
			case "Identifier":
				return reference(file, node.name, "values");
			case "YieldExpression":
			case "AwaitExpression":
				return node.argument !== null && value(file, node.argument);
			case "CallExpression":
				return value(file, node.callee);
			case "ArrowFunctionExpression":
			case "FunctionExpression":
				return !!node.returnType && walk(file, node.returnType.typeAnnotation);
			default:
				return walk(file, node);
		}
	};
	const walk = (file: string, node: Node): boolean => {
		switch (node.type) {
			case "TSTypeReference":
				if (qualified(file, node.typeName, "types")) return true;
				break;
			case "TSTypeQuery":
				if (node.exprName.type !== "TSImportType" && qualified(file, node.exprName, "values"))
					return true;
				break;
			case "TSImportType": {
				const origin = resolveImport(modules, file, node.source.value);
				const qualifier =
					node.qualifier?.type === "TSQualifiedName" ? node.qualifier.right : node.qualifier;
				if (origin && qualifier && reference(origin, qualifier.name, "types")) return true;
				break;
			}
		}
		return children(node).some((child) => walk(file, child));
	};
	return walk(file, type);
}

export const collectBindings = (sources: ReadonlyMap<string, string>) =>
	new Map(
		[...sources].map(([file, source]) => [
			file,
			moduleBindings(parseSync(file, source, { preserveParens: false }).program),
		]),
	);

export function proofBoundaryViolations(
	file: string,
	source: string,
	proofs: ReadonlySet<string>,
	bindings?: ReadonlyMap<string, ModuleBindings>,
) {
	const { program } = parseSync(file, source, { preserveParens: false });
	const modules = bindings ?? new Map([[file, moduleBindings(program)]]);
	const violations: { line: number; rule: string }[] = [];
	const report = (start: number, rule: string) => {
		violations.push({ line: source.slice(0, start).split("\n").length, rule });
	};
	const restrictMakers = !file.startsWith(PROOFS);
	const restrictPrincipals = !file.startsWith(AUTHENTICATION);
	const restrictCasts = file !== `${PROOFS}proof.ts`;
	const restrictDoubleAssertions =
		/^(?:packages\/(?:core|bot-loop)\/src\/|packages\/contracts\/src\/(?:operations|errors)\/)/.test(
			file,
		) && !DOUBLE_ASSERTION_EXCEPTIONS.has(file);
	const checkImport = (name: string, start: number) => {
		if (restrictMakers && name === "defineProof") report(start, "proofs-only-in-proofs");
		if (restrictPrincipals && name === "authenticated")
			report(start, "principals-only-in-authentication");
	};

	const checkNamespace = (source: string, start: number) => {
		if (/(?:^|\/)proofs\/proof(?:\.ts)?$/.test(source)) checkImport("defineProof", start);
		if (/(?:^|\/)principal(?:\.ts)?$/.test(source)) checkImport("authenticated", start);
	};

	new Visitor({
		ImportDeclaration(node) {
			for (const entry of node.specifiers) {
				if (entry.type === "ImportSpecifier") {
					const imported =
						entry.imported.type === "Identifier" ? entry.imported.name : entry.imported.value;
					if (node.importKind !== "type" && entry.importKind !== "type")
						checkImport(imported, entry.start);
				} else if (node.importKind !== "type" && entry.type === "ImportNamespaceSpecifier") {
					checkNamespace(node.source.value, entry.start);
				}
			}
		},
		ImportExpression(node) {
			if (node.source.type === "Literal" && typeof node.source.value === "string") {
				checkNamespace(node.source.value, node.start);
			}
		},
		ExportAllDeclaration(node) {
			if (node.exportKind !== "type") checkNamespace(node.source.value, node.start);
		},
		ExportSpecifier(node) {
			if (node.exportKind !== "type") {
				checkImport(
					node.local.type === "Identifier" ? node.local.name : node.local.value,
					node.start,
				);
			}
		},
	}).visit(program);

	new Visitor({
		TSAsExpression(node) {
			if (restrictCasts && containsProof(file, node.typeAnnotation, proofs, modules)) {
				report(node.start, "no-proof-assertion");
			}
			if (restrictDoubleAssertions && node.expression.type === "TSAsExpression") {
				report(node.start, "no-double-assertion");
			}
		},
		TSTypeAssertion(node) {
			if (restrictCasts) report(node.start, "no-prefix-assertion");
		},
		CallExpression({ callee, arguments: args }) {
			if (restrictMakers && callee.type === "Identifier" && callee.name === "defineProof")
				report(callee.start, "proofs-only-in-proofs");
			if (
				callee.type !== "MemberExpression" ||
				callee.computed ||
				callee.property.type !== "Identifier"
			)
				return;
			const { name } = callee.property;
			if (restrictMakers && (name === "defineProof" || (name === "prove" && args.length === 2)))
				report(callee.start, "proofs-only-in-proofs");
			if (
				restrictPrincipals &&
				callee.object.type === "Identifier" &&
				callee.object.name === "authenticated"
			)
				report(callee.start, "principals-only-in-authentication");
		},
	}).visit(program);
	return violations;
}

if (import.meta.main) {
	const root = resolve(import.meta.dirname, "..");
	const read = (file: string) => readFileSync(resolve(root, file), "utf8");
	const files = globSync("packages/*/src/**/*.{ts,tsx}", { cwd: root });
	const proofs = declaredProofs(
		files.filter((file) => file.startsWith(PROOFS) && !file.endsWith(".test.ts")).map(read),
	);
	const sources = new Map(files.map((file) => [file, read(file)]));
	const bindings = collectBindings(sources);
	for (const [file, source] of sources) {
		for (const { line, rule } of proofBoundaryViolations(file, source, proofs, bindings)) {
			console.error(`${file}:${line} ${rule}`);
			process.exitCode = 1;
		}
	}
}
