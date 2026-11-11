/**
 * The docs' MDX components rewritten as plain Markdown, for readers without
 * the website: bots through `read_docs`, and agents through the website's
 * Markdown versions of its pages. The website renders the components
 * themselves, from `packages/website/src/docs/components/`.
 */

import { builtInToolCatalog, providerCatalog } from "@sugabots/contracts";
import { podPartsMarkdown } from "./pod-parts.ts";
import { rolesMarkdown } from "./roles.ts";

/**
 * Each component that stands on a line of its own, as the Markdown that says
 * the same. A demo of what the prose around it already says becomes nothing.
 */
const STANDALONE_COMPONENTS: Record<string, string> = {
	RoleMatrix: rolesMarkdown(),
	PodMap: podPartsMarkdown(),
	ProviderGrid: providersMarkdown(),
	BuiltInTools: builtInToolsMarkdown(),
	ApprovalPlayground: "",
	CompactionDemo: "",
	PodGallery: "",
	RoutineBuilder: "",
	WhoReplies: "",
};

/** Side notes, quoted under their title, which defaults to the component's name. */
const ASIDES = new Set(["Tip", "Careful"]);

const CODE_FENCE = /^\s*(```|~~~)/;
const STANDALONE = /^\s*<([A-Z]\w*)\s*\/>$/;
const OPENING = /^(\s*)<([A-Z]\w*)((?:\s+\w+="[^"]*")*)\s*>$/;
const CLOSING = /^\s*<\/([A-Z]\w*)>$/;
const SAY = /^\s*<Say((?:\s+\w+="[^"]*")*)\s*>(.*)<\/Say>$/;
const ATTRIBUTE = /(\w+)="([^"]*)"/g;

/** A component open around the lines being read: its name and, for a quoted one, the indent its quote starts at. */
interface OpenComponent {
	name: string;
	quoteIndent?: string;
}

/**
 * The page's body with every component replaced by Markdown. Fails on a
 * component this file doesn't know, so a new one gets a Markdown form, or is
 * dropped on purpose, before it reaches a reader as a raw tag.
 */
export function componentsAsMarkdown(slug: string, body: string): string {
	const output: string[] = [];
	const open: OpenComponent[] = [];
	let inCodeFence = false;
	const quoteIndent = () =>
		open.findLast((component) => component.quoteIndent !== undefined)?.quoteIndent;
	const push = (markdown: string) => {
		const indent = quoteIndent();
		for (const line of markdown.split("\n")) {
			if (indent === undefined) output.push(line);
			else if (line.trim() === "") output.push(`${indent}>`);
			else
				output.push(
					`${indent}> ${line.startsWith(indent) ? line.slice(indent.length) : line.trimStart()}`,
				);
		}
	};
	// A tag that leaves nothing in its place takes the blank line before it, so
	// one blank line still separates the paragraphs around it.
	const dropBlankLineBefore = () => {
		if (output.at(-1)?.trim() === "") output.pop();
	};
	const unknown = (name: string) =>
		new Error(
			`docs page ${slug} uses <${name}>, which has no Markdown form in packages/docs/src/components-as-markdown.ts`,
		);

	for (const line of body.split("\n")) {
		if (CODE_FENCE.test(line)) inCodeFence = !inCodeFence;
		if (inCodeFence || CODE_FENCE.test(line)) {
			push(line);
			continue;
		}

		const standalone = STANDALONE.exec(line)?.[1];
		if (standalone) {
			const markdown = STANDALONE_COMPONENTS[standalone];
			if (markdown === undefined) throw unknown(standalone);
			if (markdown === "") dropBlankLineBefore();
			else push(markdown);
			continue;
		}

		const say = SAY.exec(line);
		if (say) {
			push(chatLine(attributes(say[1] ?? ""), say[2] ?? ""));
			push("");
			continue;
		}

		const opening = OPENING.exec(line);
		if (opening) {
			const [, indent = "", name = "", attributeText = ""] = opening;
			const { title } = attributes(attributeText);
			if (ASIDES.has(name)) {
				if (quoteIndent() !== undefined)
					throw new Error(`docs page ${slug} nests <${name}> in a quote`);
				open.push({ name, quoteIndent: indent });
				push(`**${title ?? name}**`);
			} else if (name === "Chat") {
				if (quoteIndent() !== undefined)
					throw new Error(`docs page ${slug} nests <${name}> in a quote`);
				open.push({ name, quoteIndent: indent });
				push(`_${title ?? "A chat"}_`);
				push("");
			} else if (name === "Steps") {
				dropBlankLineBefore();
				open.push({ name });
			} else {
				throw unknown(name);
			}
			continue;
		}

		const closing = CLOSING.exec(line)?.[1];
		if (closing) {
			const component = open.pop();
			if (component?.name !== closing)
				throw new Error(`docs page ${slug} closes <${closing}> where it didn't open one`);
			if (component.quoteIndent === undefined) dropBlankLineBefore();
			else while (output.at(-1) === `${component.quoteIndent}>`) output.pop();
			continue;
		}

		push(line);
	}
	if (open.length > 0) throw new Error(`docs page ${slug} never closes <${open.at(-1)?.name}>`);
	return output.join("\n");
}

function attributes(text: string): Record<string, string> {
	return Object.fromEntries([...text.matchAll(ATTRIBUTE)].map(([, name, value]) => [name, value]));
}

/** One `Say` from a demo chat: its speaker, whom it asked if it asked another bot, and its words. */
function chatLine({ from, collaboratesWith }: Record<string, string>, words: string): string {
	const speaker = `**${castName(from ?? "")}**`;
	const asked = collaboratesWith ? ` (asked ${castName(collaboratesWith)})` : "";
	return `${speaker}${asked}: ${words.trim()}`;
}

/** The website's demo cast is keyed by each name in camel case: `tripPlanner` is Trip Planner. */
function castName(key: string): string {
	const words = key.replace(/([A-Z])/g, " $1");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function providersMarkdown(): string {
	const list = (hosting: "remote" | "local") =>
		providerCatalog
			.filter((preset) => preset.hosting === hosting)
			.map((preset) => `- **${preset.name}**: ${preset.hint}`)
			.join("\n");
	return ["Hosted services:", list("remote"), "On your own machine:", list("local")].join("\n\n");
}

function builtInToolsMarkdown(): string {
	const rows = builtInToolCatalog.map(
		({ key, name, description }) => `| ${name} | \`${key}\` | ${description} |`,
	);
	return ["| Tool | Key | What it does |", "| --- | --- | --- |", ...rows].join("\n");
}
