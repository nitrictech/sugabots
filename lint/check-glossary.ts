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
 * reader can tell. Nor is "activity", the inbox's old name, which is also the
 * workflow engine's word for a step and plain English for what goes on.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

interface RetiredWord {
	/** The singular in lower case, as it starts an identifier. */
	readonly word: string;
	readonly plural: string;
	/** What GLOSSARY.md says to use instead. */
	readonly replacement: string;
	readonly failing: boolean;
	/** Uses of the word that mean something else, removed before matching. */
	readonly otherMeanings?: RegExp;
	/** Files where the word is only ever someone else's, so it isn't checked there. */
	readonly keptIn?: readonly RegExp[];
}

const RETIRED_WORDS: readonly RetiredWord[] = [
	{
		word: "pod",
		plural: "pods",
		replacement: "project, or the bot",
		failing: true,
		// Names run from outside, which keep their old words: the script that
		// destroys the computers bots used to share, and migrations by their
		// names. And Apple's iPod.
		otherMeanings: /destroy-pod-computers|\b\d{14}_[a-z0-9_]+|iPod/g,
		keptIn: [
			// Run against a database from before channels had their name.
			/^packages\/core\/src\/computers\/destroy-pod-computers\.ts$/,
		],
	},
	{ word: "crew", plural: "crews", replacement: "the project's bots", failing: true },
	{
		word: "artifact",
		plural: "artifacts",
		replacement: "file",
		failing: true,
		// The blob store's folder for the files bots write, `artifacts/<fileId>`,
		// which keeps the name their content was first stored under.
		otherMeanings: /`artifacts\/(?:<fileId>|\$\{)[^`]*`|BlobStore\.key\("artifacts"/g,
	},
	{
		word: "sandbox",
		plural: "sandboxes",
		replacement: "computer",
		failing: true,
		// Others' names: the OpenSandbox provider, its server's setting, SDK and
		// container names; E2B's `sandboxUrl`; Chromium's and an iframe's
		// sandbox. And names kept because something outside the code holds
		// them: the published image and E2B template `sugabots-sandbox`, the
		// certificate name in computers' homes, the tool name earlier calls
		// record, and the tables as a database not yet migrated has them.
		otherMeanings:
			/OpenSandbox|SANDBOX_CONFIG_PATH|SandboxManager|listSandboxInfos|`sandbox-\$\{|sandboxUrl|E2B_SANDBOX_URL|--no-sandbox|chromium_sandbox_flags|Chromium's flags for its own sandbox|sugabots-sandbox|PROVIDER_AUTHORITY=sandbox-provider|copy_file_to_sandbox|DELETE FROM sandbox WHERE provider_sandbox_id|toHaveAttribute\("sandbox"/g,
		keptIn: [
			// Talking to each provider in its own words.
			/^packages\/core\/src\/computers\/implementations\//,
			// Run against a database from before computers had their name.
			/^packages\/core\/src\/computers\/destroy-pod-computers\.ts$/,
			// Nix's build sandbox.
			/^docker\/computer\/nix\/nix\.conf$/,
			// The browser's: an iframe's `sandbox` and Content-Security-Policy's.
			/^packages\/web\/src\/screens\/HtmlFrame\.tsx$/,
			/^packages\/server\/src\/http\/content-pages(\.test)?\.ts$/,
			/^packages\/server\/src\/routes\/chats\/(file-response|files\.test)\.ts$/,
		],
	},
	{ word: "scribe", plural: "scribes", replacement: "summariser", failing: true },
	{
		word: "agent",
		plural: "agents",
		replacement: "bot",
		failing: true,
		// Others' agents: the HTTP user agent, coding agents and their
		// AGENTS.md, crawlers and AI agents generally, and SSH's and GPG's. And
		// names stored or run from outside, which keep
		// their old words: the key workflow payloads store the bot's id under, and
		// the user and folder bots' homes are in on the computers made before.
		otherMeanings:
			/user[-_ ]?agents?|AGENTS\.md|AI agents?|your[- ]agent|(?:ssh|gpg)-agent|SSH and GPG agents|\bagentId(?=: (?:Schema\.String|botId|crypto\.randomUUID\(\)))|\{ agentId,|: agentId\b|stored\.agentId|name: "agent"|\/home\/agent|WORKSPACE_DIRECTORY\}\/agents/gi,
		keptIn: [
			// undici's Agent, the connection pool requests are sent through.
			/^packages\/core\/src\/providers\/network\/egress(\.test)?\.ts$/,
		],
	},
	{
		word: "channel",
		plural: "channels",
		replacement: "project",
		failing: true,
		// Others' channels: Slack's, and its `@channel`, which a person writes to
		// mention everyone in a conversation; the browser's MessageChannel; the
		// Postgres notification channel, and the event table's `channel`, the stream
		// an event is published on; Xfce's settings channels. And migrations by
		// their names.
		otherMeanings:
			/@channel|"here", "channel"|handle: "channel"|name: "Channel"|\[\["channel", "reviewer"\]\]|`here` or `channel`|"here and channel"|Slack's channel|per channel\.|MessageChannel|NOTIFY_CHANNEL|notification channel|text\("channel"\)|event_channel_seq_idx|perchannel|\b\d{14}_[a-z0-9_]+/g,
		keptIn: [
			// A colour's red, green and blue channels.
			/^docker\/computer\/sugabots-desktop-look$/,
			// Xfce's settings, kept in channels.
			/^docker\/computer\/xfce\//,
			// Mock Service Worker's own script, talking to its page over a MessageChannel.
			/^packages\/web\/\.storybook\/public\/mockServiceWorker\.js$/,
		],
	},
	{
		word: "main chat",
		plural: "main chats",
		replacement: "a project's threads",
		failing: true,
	},
	{
		word: "main thread",
		plural: "main threads",
		replacement: "a project's threads",
		failing: true,
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
 * `podId`, `isPod`, `PodComputers`, `pod_id` and `POD_ID`, but not `tripod`
 * or `podcast`. A word of several, such as "main chat", is matched with its
 * parts apart or joined as an identifier joins them: `main chat`, `main-chat`,
 * `mainChat`, `MainChat` and `MAIN_CHAT`.
 */
function wordPattern({ word, plural }: RetiredWord): RegExp {
	const forms = (casing: (part: string) => string, joinings: (part: string) => string[]) =>
		[plural, word]
			.map((phrase) => {
				const [first = "", ...rest] = phrase.split(" ");
				return casing(first) + rest.map((part) => `(?:${joinings(part).join("|")})`).join("");
			})
			.join("|");
	const lower = forms(
		(part) => part,
		(part) => [`[ _-]${part}`, `[ _-]?${capitalise(part)}`],
	);
	const capitalised = forms(capitalise, (part) => [`[ _-]${part}`, `[ _-]?${capitalise(part)}`]);
	const upper = forms(
		(part) => part.toUpperCase(),
		(part) => [`[ _-]?${part.toUpperCase()}`],
	);
	return new RegExp(
		[
			`(?<![A-Za-z])(?:${lower})(?![a-z])`,
			`(?<![A-Z])(?:${capitalised})(?![a-z])`,
			`(?<![A-Za-z])(?:${upper})(?![A-Za-z])`,
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
		if (retired.keptIn?.some((kept) => kept.test(path))) continue;
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
		// A tracked file deleted in the working tree has nothing left to check.
		.filter(
			(path) =>
				path !== "" && !SKIPPED_PATHS.some((skipped) => skipped.test(path)) && existsSync(path),
		);
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
