/**
 * Finds the words GLOSSARY.md retires in tracked files: in identifiers,
 * comments, strings and docs alike.
 *
 * `node lint/check-glossary.ts` fails if any word marked `failing` is found,
 * listing where. `--report` also counts every retired word by package, so a
 * cleanup round can see what is left. A word becomes failing once the round
 * that removes it is done, so it can't come back.
 *
 * Words whose meaning changed rather than ended, such as "thread", aren't
 * checked: whether one is right depends on what it means there, which only a
 * reader can tell.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface RetiredWord {
	/** The singular in lower case, as it starts an identifier. */
	readonly word: string;
	readonly plural: string;
	/** What GLOSSARY.md says to use instead. */
	readonly replacement: string;
	readonly failing: boolean;
	/** Uses of the word that mean something else, removed before matching. */
	readonly otherMeanings?: RegExp;
}

const RETIRED_WORDS: readonly RetiredWord[] = [
	{ word: "pod", plural: "pods", replacement: "channel, or the bot", failing: false },
	{ word: "crew", plural: "crews", replacement: "the channel's bots", failing: false },
	{ word: "artifact", plural: "artifacts", replacement: "file", failing: false },
	{ word: "sandbox", plural: "sandboxes", replacement: "computer", failing: false },
	{ word: "scribe", plural: "scribes", replacement: "summariser", failing: false },
	{
		word: "agent",
		plural: "agents",
		replacement: "bot",
		failing: false,
		otherMeanings: /user[-_ ]?agent|AGENTS\.md/gi,
	},
];

/** Tracked files that keep old words on purpose, or aren't ours to edit. */
const SKIPPED_PATHS: readonly RegExp[] = [
	/^GLOSSARY\.md$/,
	/^lint\/check-glossary\.ts$/,
	/^packages\/core\/drizzle\//,
	/^packages\/emoji\/src\/emoji\.json$/,
	/(^|\/)bun\.lock$/,
	/\.(svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|mp4|webm)$/,
];

/**
 * The word as a whole word or as one part of an identifier: `pod`, `pods`,
 * `podId`, `isPod`, `PodSandboxes`, `pod_id` and `POD_ID`, but not `tripod`
 * or `podcast`.
 */
function wordPattern({ word, plural }: RetiredWord): RegExp {
	const lower = `(?:${plural}|${word})`;
	const capitalised = `(?:${capitalise(plural)}|${capitalise(word)})`;
	const upper = `(?:${plural.toUpperCase()}|${word.toUpperCase()})`;
	return new RegExp(
		[
			`(?<![A-Za-z])${lower}(?![a-z])`,
			`(?<![A-Z])${capitalised}(?![a-z])`,
			`(?<![A-Za-z])${upper}(?![A-Za-z])`,
		].join("|"),
		"g",
	);
}

function capitalise(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

interface Finding {
	readonly path: string;
	readonly line: number;
	readonly text: string;
}

function findingsOf(retired: RetiredWord, files: ReadonlyMap<string, string>): Finding[] {
	const pattern = wordPattern(retired);
	const findings: Finding[] = [];
	for (const [path, contents] of files) {
		contents.split("\n").forEach((text, index) => {
			const checked = retired.otherMeanings ? text.replace(retired.otherMeanings, "") : text;
			for (const _match of checked.matchAll(pattern)) {
				findings.push({ path, line: index + 1, text: text.trim() });
			}
		});
	}
	return findings;
}

/** `packages/core/src/x.ts` is in `packages/core`; a file at the root is in `.`. */
function areaOf(path: string): string {
	const [first, second] = path.split("/");
	if (second === undefined) return ".";
	return first === "packages" || first === "apps" ? `${first}/${second}` : first;
}

function trackedFiles(): Map<string, string> {
	const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
		.split("\0")
		.filter((path) => path !== "" && !SKIPPED_PATHS.some((skipped) => skipped.test(path)));
	return new Map(paths.map((path) => [path, readFileSync(path, "utf8")]));
}

function printReport(retired: RetiredWord, findings: readonly Finding[]): void {
	const byArea = new Map<string, number>();
	for (const { path } of findings) {
		const area = areaOf(path);
		byArea.set(area, (byArea.get(area) ?? 0) + 1);
	}
	const status = retired.failing ? "failing" : "reported";
	console.log(`${retired.word} → ${retired.replacement}: ${findings.length} (${status})`);
	for (const [area, count] of [...byArea].sort(([, a], [, b]) => b - a)) {
		console.log(`  ${String(count).padStart(6)}  ${area}`);
	}
}

const report = process.argv.includes("--report");
const files = trackedFiles();
let failed = false;
for (const retired of RETIRED_WORDS) {
	const findings = findingsOf(retired, files);
	if (report) printReport(retired, findings);
	if (!retired.failing || findings.length === 0) continue;
	failed = true;
	console.error(`"${retired.word}" is retired; GLOSSARY.md says to use ${retired.replacement}:`);
	for (const { path, line, text } of findings) console.error(`  ${path}:${line}  ${text}`);
}
process.exitCode = failed ? 1 : 0;
