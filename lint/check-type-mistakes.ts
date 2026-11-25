import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { API, DiagnosticCategory } from "typescript/unstable/sync";

const root = join(import.meta.dirname, "..");
const fixtures = [
	["packages/core", "src/proofs/mistakes.ts"],
	["packages/contracts", "src/operations/mistakes.ts"],
] as const;
const directive = /^\s*\/\/ @ts-expect-error\b(?: TS(\d+(?:,\d+)*))?/;

for (const [directory, fixture] of fixtures) {
	const config = join(root, directory, "tsconfig.json");
	const file = join(root, directory, fixture);
	const source = readFileSync(file, "utf8");
	const lines = source.split("\n");
	const unsuppressed = source.replace(/^([ \t]*\/\/ )@ts-expect-error/gm, "$1@expected-error");
	const api = new API({
		cwd: root,
		fs: { readFile: (path) => (path === file ? unsuppressed : undefined) },
	});
	try {
		const project = api.updateSnapshot({ openProjects: [config] }).getProject(config);
		if (!project) throw new Error(`Could not load ${config}`);
		const diagnostics = new Map<number, number[]>();
		for (const diagnostic of project.program.getSemanticDiagnostics(file)) {
			if (diagnostic.category !== DiagnosticCategory.Error) continue;
			const line = unsuppressed.slice(0, diagnostic.pos).split("\n").length;
			const codes = diagnostics.get(line) ?? [];
			codes.push(diagnostic.code);
			diagnostics.set(line, codes);
		}
		for (const [index, line] of lines.entries()) {
			const match = directive.exec(line);
			if (!match) continue;
			const target = index + 2;
			const actual = (diagnostics.get(target) ?? []).sort().join(",");
			const expected = match[1];
			if (actual !== expected) {
				console.error(
					`${relative(root, file)}:${target}: expected TS${expected ?? " code"}, got ${actual ? `TS${actual}` : "no diagnostic"}`,
				);
				process.exitCode = 1;
			}
			diagnostics.delete(target);
		}
		for (const [line, codes] of diagnostics) {
			console.error(`${relative(root, file)}:${line}: unexpected TS${codes.join(",")}`);
			process.exitCode = 1;
		}
	} finally {
		api.close();
	}
}
