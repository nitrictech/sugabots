/**
 * Finds, in tracked files, the words GLOSSARY.md retires and the banned
 * synonyms it can tell apart from other senses: in identifiers, comments,
 * strings and docs alike.
 *
 * `node lint/check-glossary.ts` fails if any is found, listing where, so none
 * can come back. `--report` also counts each by package.
 *
 * Only words a machine can tell are meant in the banned sense are checked.
 * Retired words whose meaning changed rather than ended, such as "task",
 * "schedule", "document" and "routine", are left to the reader, as is
 * "summary", which is plain English as often as it is the retired summary.
 * So are banned synonyms that are everyday words or another system's own:
 * "user" (HTTP's user agent, a user message, the current user), "workspace
 * bot" and "internal bot" (any bot in the workspace, and a made-up project's
 * name), "done" and "archived" alone (only their names for a chat's state are
 * checked), "activity" (the workflow engine's word for a step), "streaming"
 * and "reasoning" (the model providers' and the event stream's), "snapshot"
 * (Playwright's), "VNC" (the desktop's protocol), "callback", "endpoint" and
 * "hook" (OAuth's, HTTP's, and React's and better-auth's hooks), "sender" (an
 * email's), "condition" (a query's), "system prompt" and "function call" (a
 * model provider's API), "organisation" (GitHub's), "routing", "dispatch",
 * "seen", "app" (the web app, a GitHub app), "scope", "context" and "sandbox"
 * (turn bounds'; OAuth's scopes, React's contexts, a browser's sandbox): only
 * "approval app", a tool source's old compound name, is checked.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Table } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { toString as plainText } from "mdast-util-to-string";
import { gfmTable } from "micromark-extension-gfm-table";

interface CheckedWord {
	/** The singular in lower case, as it starts an identifier. */
	readonly word: string;
	/** When it isn't the singular with "s" or "es" on the end. */
	readonly plural?: string;
	/** The word GLOSSARY.md lists, when this is another spelling of it or a phrase made from it. */
	readonly formOf?: string;
	/** Uses of the word that mean something else, removed before matching. */
	readonly otherMeanings?: RegExp;
	/** Files where the word is only ever someone else's, so it isn't checked there. */
	readonly keptIn?: readonly RegExp[];
}

/**
 * The retired terms and banned synonyms checked, each as GLOSSARY.md lists it
 * or a phrase made from one, with what tells it from its other senses. Whether
 * it is retired, and what to use instead, are read from GLOSSARY.md.
 */
const CHECKED_WORDS: readonly CheckedWord[] = [
	// Retired terms
	{
		word: "pod",
		// Apple's iPod.
		otherMeanings: /iPod/g,
	},
	{ word: "crew" },
	{
		word: "channel",
		// Others' channels: Slack's `@channel`, which a member writes to mention
		// everyone in a chat, the Postgres notification channel, and Node's
		// diagnostics channels.
		otherMeanings:
			/@channel|"here", "channel"|handle: "channel"|name: "Channel"|\[\["channel", "reviewer"\]\]|`here` or `channel`|"here and channel"|NOTIFY_CHANNEL|notification channel|diagnostics_channel|diagnosticsChannel|diagnostics channel/g,
		keptIn: [
			// A colour's red, green and blue channels.
			/^docker\/computer\/sugabots-desktop-look$/,
			// Xfce's settings, kept in channels.
			/^docker\/computer\/xfce\//,
			// Mock Service Worker's own script, talking to its page over a MessageChannel.
			/^packages\/web\/\.storybook\/public\/mockServiceWorker\.js$/,
		],
	},
	{ word: "main chat" },
	{ word: "main thread" },
	{ word: "artifact" },
	{
		word: "sandbox",
		// Others' names: the OpenSandbox provider, its server's setting, SDK and
		// container names; E2B's `sandboxUrl`; Chromium's and an iframe's
		// sandbox. And names kept because something outside the code holds
		// them: the published image and E2B template `sugabots-sandbox`, the
		// certificate name in computers' homes, and the tables as a database
		// not yet migrated has them.
		otherMeanings:
			/OpenSandbox|SANDBOX_CONFIG_PATH|SandboxManager|listSandboxInfos|`sandbox-\$\{|sandboxUrl|E2B_SANDBOX_URL|--no-sandbox|chromium_sandbox_flags|Chromium's flags for its own sandbox|sugabots-sandbox|PROVIDER_AUTHORITY=sandbox-provider|toHaveAttribute\("sandbox"/g,
		keptIn: [
			// Talking to each provider in its own words.
			/^packages\/core\/src\/computers\/implementations\//,
			// Nix's build sandbox.
			/^docker\/computer\/nix\/nix\.conf$/,
			// The browser's: an iframe's `sandbox` and Content-Security-Policy's.
			/^packages\/web\/src\/screens\/HtmlFrame\.tsx$/,
			/^packages\/server\/src\/http\/content-pages(\.test)?\.ts$/,
			/^packages\/server\/src\/routes\/chat-files\/(file-response|routes\.test)\.ts$/,
		],
	},
	{
		word: "agent",
		// Others' agents: the HTTP user agent, coding agents, crawlers and AI
		// agents generally, and SSH's and GPG's.
		otherMeanings:
			/user[-_ ]?agents?|AI agents?|your[- ]agent|(?:ssh|gpg)-agent|SSH and GPG agents/gi,
		keptIn: [
			// undici's Agent, the connection pool requests are sent through.
			/^packages\/core\/src\/providers\/network\/egress(\.test)?\.ts$/,
			/^packages\/core\/src\/computers\/implementations\/computer-egress\.test\.ts$/,
		],
	},
	{ word: "bot summary" },
	{ word: "summariser" },
	{ word: "summarizer", formOf: "summariser" },
	{ word: "scribe" },
	{
		word: "inbox",
		// An email inbox: the one a sign-up link is sent to, and the ones bots
		// in examples sort.
		otherMeanings:
			/(?:in|[Ss]ort|[Ss]orts|[Ss]orting) (?:its|the) inbox|(?:support|shared) inbox|inbox sweep|Inbox (?:Sorter|Manager|triage)|inboxSorter|read_inbox/g,
	},
	{
		word: "direct message",
	},

	// Members and the workspace
	{ word: "tenant" },
	{
		word: "person",
		// PostHog's own setting for the profiles it keeps of a site's visitors,
		// and "personal" in capitals, which the acronym-led form would match.
		otherMeanings: /person_profiles|PERSONAL_/g,
	},
	{ word: "people", plural: "people", formOf: "person" },
	{
		word: "session user",
		formOf: "user",
	},
	{
		word: "transfer ownership",
		formOf: "transfer",
		plural: "transferred ownership",
	},
	{ word: "super admin" },
	{ word: "superuser" },
	{
		word: "workspace invite",
		formOf: "invite",
	},
	{ word: "sysadmin" },

	// Bots
	{ word: "shared bot" },
	{
		word: "unlisted bot",
	},
	{
		word: "invite-only bot",
	},
	{
		word: "hidden bot",
	},
	{
		word: "secret bot",
	},
	{
		word: "background bot",
	},
	{
		word: "llm provider",
	},
	{
		word: "native tool",
	},
	{
		word: "mcp tool",
		// The protocol's own word for a tool's result, and Exa's search tool.
		otherMeanings: /MCP tool result|Exa's MCP tool/g,
	},
	{
		word: "preset",
		// Others' presets: Biome's rules and ffmpeg's encoder speed.
		otherMeanings: /"preset": "recommended"|"-preset",/g,
	},
	{
		word: "catalog entry",
		// A tool that tool search can find, in the turn's catalog of them.
		otherMeanings: /CatalogEntry/g,
	},

	// Projects and chats
	{
		word: "thread",
		// A web forum's, and GitHub's comments on a pull request's code.
		otherMeanings: /forum thread|review thread|reviewThreadId/g,
	},
	{ word: "conversation" },
	{ word: "default bot" },
	{
		word: "home project",
	},
	{ word: "mark done", formOf: "done", plural: "marked done" },
	{
		word: "chat done",
		formOf: "done",
		plural: "chats done",
	},
	{ word: "done at", formOf: "done", plural: "done at" },
	{
		word: "archive chat",
		formOf: "archived",
		plural: "archived chat",
	},
	{
		word: "subagent",
	},
	{
		word: "kickoff message",
	},
	{ word: "handover note" },
	{ word: "decider" },
	{ word: "chat type" },
	{
		word: "read state",
	},
	{
		word: "read receipt",
	},

	// A project's resources
	{
		word: "sealed address",
	},
	{
		word: "share link",
	},
	{
		word: "connection",
		// Other connections: a socket's, an HTTP request's, a WebSocket's, the
		// event stream's, a database's, and the computer providers' SDKs' own.
		otherMeanings:
			/closeAllConnections|ProviderConnectionLost|ConnectionConfig|connectionConfig|ConnectionOpts|Connections Sugabots makes|viewer's connection|per connection|No connection to|connection never made|dead connection|same connection|(?:[Cc]heck|lost|dropped|refused|open|first|desktop viewer's|hidden page's) (?:the |your )?connection|connection (?:drops|dropped|refused|ended|open|could be made|is made|to (?:one|any other host|the browser|the event stream|\$\{)|holds the computer awake|pool)|(?:A|a) connection (?:to|holds)|direct connection/g,
		keptIn: [
			// A model request's socket, made, refused or dropped.
			/^packages\/core\/src\/providers\/models\/request-failures\.ts$/,
			// The HTTP headers a client owns, `Connection` among them.
			/^packages\/contracts\/src\/model-providers(?:\.test)?\.ts$/,
			// Database, network and socket connections.
			/^packages\/core\/src\/database\//,
			/^packages\/workflow\//,
			/^packages\/core\/src\/accounting\/usage\.ts$/,
			/^packages\/core\/src\/providers\/network\//,
			/^packages\/server\/src\/auth\/authentication\.ts$/,
			/^packages\/sdk\/src\/events(?:\.test)?\.ts$/,
			/^packages\/docs\/content\/(?:configuration|deploy-with-docker)\.mdx$/,
			/^packages\/website\/scripts\/capture\/environment\.ts$/,
			/^\.env\.example$/,
			/^compose\.yml$/,
			/^docker\//,
			/^LICENSE\.md$/,
		],
	},
	{
		word: "whitelist",
	},
	{
		word: "allowed domain",
	},
	{
		word: "blacklist",
	},
	{
		word: "denylist",
	},
	{
		word: "blocked domain",
	},
	{
		word: "allowlist",
		formOf: "allowlist mode",
	},
	{
		word: "network access request",
	},
	{ word: "unpriced", formOf: "unpriced request", plural: "unpriced" },
	{ word: "estimated cost" },
	{ word: "sealed value" },
	{
		word: "encrypted value",
	},
	{
		word: "screen share",
	},
	{
		word: "remote view",
	},
	{ word: "ad-hoc run" },
	{ word: "run now", plural: "run now" },
	{
		word: "approval app",
		formOf: "app",
	},
	{
		word: "tool permission",
	},
	{
		word: "tool policy",
	},

	// Architecture
	{
		word: "entry point",
		// Docker's entrypoint, which names the program a container starts.
		otherMeanings: /ENTRYPOINT/g,
	},
	{ word: "agent loop" },
	{
		word: "agent runtime",
	},
	{
		word: "use case",
		// Plain English for what a story or an issue is for, and Mock Service
		// Worker's own script.
		keptIn: [
			/^packages\/web\/\.storybook\/public\/mockServiceWorker\.js$/,
			/^CONTRIBUTING\.md$/,
			/^\.github\//,
		],
	},
	{
		word: "tool registry",
	},
	{
		word: "chain of thought",
		plural: "chains of thought",
	},
	{
		word: "live typing",
		plural: "live typing",
	},
	{
		word: "model call",
		// The verb: what the model calls, a tool. And the AI SDK's callbacks.
		otherMeanings: /(?:[Tt]he|key the) model calls|LanguageModelCall/g,
	},
	{
		word: "mutates",
		plural: "mutates",
	},
	{
		word: "mutating",
		plural: "mutating",
		// TanStack Query's count of requests under way.
		otherMeanings: /useIsMutating|isMutating/g,
	},
	{
		word: "spill file",
	},
	{ word: "rerun" },

	// Errors
	{ word: "error id" },
	{
		word: "incident number",
	},
	{
		word: "wire error",
	},
	{
		word: "third-party error",
	},
	{
		word: "display message",
	},
];

/** Tracked files that keep old words on purpose, or aren't ours to edit. */
const SKIPPED_PATHS: readonly RegExp[] = [
	/^GLOSSARY\.md$/,
	/^lint\/check-glossary\.ts$/,
	/^packages\/core\/drizzle\//,
	/^patches\/e2b@[^/]+\.patch$/,
	/^packages\/core\/src\/database\/upgrade\.test(-support)?\.ts$/,
	// The addresses and docs pages from before projects, which other systems
	// and links still use, and the upgrade notes, which name what an upgraded
	// installation had.
	/^packages\/server\/src\/http\/renamed-paths(\.test)?\.ts$/,
	/^packages\/website\/src\/renamed-docs\.ts$/,
	/^packages\/docs\/content\/upgrading-to-projects\.mdx$/,
	/^packages\/emoji\/src\/emoji\.json$/,
	/(^|\/)bun\.lock$/,
	/\.(svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|mp4|webm)$/,
];

/**
 * The word as a whole word or as one part of an identifier: `pod`, `pods`,
 * `podId`, `isPod`, `PodComputers`, `pod_id` and `POD_ID`, but not `tripod`
 * or `podcast`. A word of several, such as "main chat", is matched with its
 * parts apart or joined as an identifier joins them: `main chat`, `main-chat`,
 * `mainChat`, `MainChat` and `MAIN_CHAT`. One led by an acronym is matched
 * with the acronym in capitals too: `MCP tool`, `MCPTool` and `LLM provider`.
 */
function wordPattern({ word, plural = pluralise(word) }: CheckedWord): RegExp {
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
	const acronymLed = forms(
		(part) => part.toUpperCase(),
		(part) => [`[ _-]${part}`, `[ _-]?${capitalise(part)}`],
	);
	return new RegExp(
		[
			`(?<![A-Za-z])(?:${lower})(?![a-z])`,
			`(?<![A-Z])(?:${capitalised})(?![a-z])`,
			`(?<![A-Za-z])(?:${upper})(?![A-Za-z])`,
			`(?<![A-Za-z])(?:${acronymLed})(?![a-z])`,
		].join("|"),
		"g",
	);
}

/** The phrase with its last word made plural: "main chat" to "main chats", "entry" to "entries". */
function pluralise(phrase: string): string {
	if (/[^aeiou]y$/.test(phrase)) return `${phrase.slice(0, -1)}ies`;
	if (/(?:s|x|ch|sh)$/.test(phrase)) return `${phrase}es`;
	return `${phrase}s`;
}

function capitalise(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A word GLOSSARY.md says not to use, and what to use instead. */
interface GlossaryWord {
	/** In lower case, without the note in brackets some carry, such as "invite (as a noun)". */
	readonly word: string;
	/** Whether it carried such a note, so it is banned only in that sense. */
	readonly noted: boolean;
	/** For a retired term, what replaced it; for a banned synonym, the term it is banned for. */
	readonly useInstead: string;
	readonly retired: boolean;
}

/** The words in GLOSSARY.md's tables of retired terms and of terms with their banned synonyms. */
function parseGlossary(markdown: string): GlossaryWord[] {
	const tree = fromMarkdown(markdown, {
		extensions: [gfmTable()],
		mdastExtensions: [gfmTableFromMarkdown()],
	});
	const tables = tree.children.filter((node): node is Table => node.type === "table");
	return tables.flatMap(({ children: [header, ...rows] }) => {
		const lastColumn = header?.children.at(-1);
		const heading = lastColumn ? plainText(lastColumn) : "";
		if (heading !== "Now" && heading !== "Banned synonyms") return [];
		return rows.flatMap(({ children: [termCell, , lastCell] }): GlossaryWord[] => {
			if (!termCell || !lastCell) return [];
			const useInsteadOrTerm = plainText(lastCell).replace(/\.$/, "");
			if (heading === "Now") {
				// A row may retire several terms, each in bold: "**Main chat**, **main thread**".
				return termCell.children
					.filter((node) => node.type === "strong")
					.map((term) => ({
						...readWord(plainText(term)),
						useInstead: useInsteadOrTerm,
						retired: true,
					}));
			}
			return useInsteadOrTerm
				.split(/,\s*(?![^()]*\))/)
				.filter((synonym) => /\p{L}/u.test(synonym))
				.map((synonym) => ({
					...readWord(synonym),
					useInstead: plainText(termCell),
					retired: false,
				}));
		});
	});
}

/** "Invite (as a noun)" as the word "invite", noted. */
function readWord(listed: string): Pick<GlossaryWord, "word" | "noted"> {
	const word = listed.replace(/\s*\(.*\)\s*$/, "").trim();
	return { word: word.toLowerCase(), noted: word !== listed.trim() };
}

/**
 * The glossary's entries for a checked word. A retired term is retired whatever
 * else it is banned for, as "channel" is. Where a word is banned both plainly and
 * with a note, as "user" is, the plain entries are the ones meant.
 */
function findInGlossary(checked: CheckedWord, glossary: readonly GlossaryWord[]): GlossaryWord[] {
	const listed = glossary.filter((entry) => entry.word === (checked.formOf ?? checked.word));
	const retired = listed.filter((entry) => entry.retired);
	if (retired.length > 0) return retired;
	const plain = listed.filter((entry) => !entry.noted);
	return plain.length > 0 ? plain : listed;
}

/** "retired", or what the word is a banned synonym of. */
function describe(entries: readonly GlossaryWord[]): string {
	if (entries.some((entry) => entry.retired)) return "retired";
	return `banned for ${joinDistinct(entries.map((entry) => entry.useInstead))}`;
}

/** What GLOSSARY.md says to use instead. */
function replacementFor(entries: readonly GlossaryWord[]): string {
	return joinDistinct(entries.map((entry) => entry.useInstead));
}

function joinDistinct(texts: readonly string[]): string {
	return [...new Set(texts)].join(" or ");
}

interface Finding {
	readonly path: string;
	readonly line: number;
	readonly text: string;
}

function findingsOf(checked: CheckedWord, files: ReadonlyMap<string, string>): Finding[] {
	const pattern = wordPattern(checked);
	const findings: Finding[] = [];
	for (const [path, contents] of files) {
		if (checked.keptIn?.some((kept) => kept.test(path))) continue;
		contents.split("\n").forEach((text, index) => {
			const kept = checked.otherMeanings ? text.replace(checked.otherMeanings, "") : text;
			for (const _match of kept.matchAll(pattern)) {
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

function printReport(
	checked: CheckedWord,
	entries: readonly GlossaryWord[],
	findings: readonly Finding[],
): void {
	const byArea = new Map<string, number>();
	for (const { path } of findings) {
		const area = areaOf(path);
		byArea.set(area, (byArea.get(area) ?? 0) + 1);
	}
	console.log(
		`${checked.word} (${describe(entries)}) → ${replacementFor(entries)}: ${findings.length}`,
	);
	for (const [area, count] of [...byArea].sort(([, a], [, b]) => b - a)) {
		console.log(`  ${String(count).padStart(6)}  ${area}`);
	}
}

const report = process.argv.includes("--report");
const glossary = parseGlossary(readFileSync("GLOSSARY.md", "utf8"));
const files = trackedFiles();
let failed = false;
for (const checked of CHECKED_WORDS) {
	const entries = findInGlossary(checked, glossary);
	if (entries.length === 0) {
		failed = true;
		console.error(
			`"${checked.formOf ?? checked.word}" is checked here but GLOSSARY.md doesn't retire or ban it. Remove it from lint/check-glossary.ts, or add it to the glossary.`,
		);
		continue;
	}
	const findings = findingsOf(checked, files);
	if (report) printReport(checked, entries, findings);
	if (findings.length === 0) continue;
	failed = true;
	console.error(
		`"${checked.word}" is ${describe(entries)}; GLOSSARY.md says to use ${replacementFor(entries)}:`,
	);
	for (const { path, line, text } of findings) console.error(`  ${path}:${line}  ${text}`);
}
process.exitCode = failed ? 1 : 0;
