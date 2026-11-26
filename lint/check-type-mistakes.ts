import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { API, type Diagnostic, DiagnosticCategory } from "typescript/unstable/sync";

const root = join(import.meta.dirname, "..");
const fixtures = [
	["packages/core", "src/proofs/mistakes.ts"],
	["packages/contracts", "src/operations/mistakes.ts"],
	["packages/contracts", "src/http/mistakes.ts"],
] as const;
const directive = /^\s*\/\/ @ts-expect-error\b(?: TS(\d+) \[(.+)\])?/;

function* diagnosticMessages(diagnostic: Diagnostic): Generator<string> {
	yield diagnostic.text;
	for (const detail of diagnostic.messageChain ?? []) yield* diagnosticMessages(detail);
}

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
		const diagnostics = new Map<number, Array<{ code: number; messages: string[] }>>();
		for (const diagnostic of project.program.getSemanticDiagnostics(file)) {
			if (diagnostic.category !== DiagnosticCategory.Error) continue;
			const line = unsuppressed.slice(0, diagnostic.pos).split("\n").length;
			const found = diagnostics.get(line) ?? [];
			found.push({ code: diagnostic.code, messages: [...diagnosticMessages(diagnostic)] });
			diagnostics.set(line, found);
		}
		for (const [index, line] of lines.entries()) {
			const match = directive.exec(line);
			if (!match) continue;
			const target = index + 2;
			const actual = diagnostics.get(target) ?? [];
			const [, code, fragment] = match;
			if (!code || !fragment) {
				console.error(
					`${relative(root, file)}:${index + 1}: expected a TS code and message fragment`,
				);
				process.exitCode = 1;
			} else if (
				actual.length !== 1 ||
				actual[0]?.code !== Number(code) ||
				!actual[0].messages.some((message) => message.includes(fragment))
			) {
				const found = actual.map(({ code, messages }) => `TS${code}: ${messages.join(" ")}`);
				console.error(
					`${relative(root, file)}:${target}: expected TS${code} containing ${JSON.stringify(fragment)}, got ${found.join("; ") || "no diagnostic"}`,
				);
				process.exitCode = 1;
			}
			diagnostics.delete(target);
		}
		for (const [line, found] of diagnostics) {
			console.error(
				`${relative(root, file)}:${line}: unexpected TS${found.map(({ code }) => code).join(",")}`,
			);
			process.exitCode = 1;
		}
	} finally {
		api.close();
	}
}
