import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseSync, Visitor } from "oxc-parser";

const SOURCE_DIRECTORIES = ["packages/web/src", "packages/website/src"];
const PALETTE_COLOUR =
	/^(?:accent|bg|border(?:-[trblxyse])?|caret|decoration|divide|drop-shadow|fill|from|inset-ring|inset-shadow|outline|placeholder|ring(?:-offset)?|shadow|stroke|text|to|via)-(?:black|white|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950))$/;
const BRACKETED_PROPERTY = /^\[(?:--)?[a-z][\w-]*:/i;
const BRACKETED_VALUE = /^-?[a-z][\w-]*[-/]\[/i;

// Only the website imports tw-animate-css.
const WEB_SOURCE = "packages/web/src/";
const PLUGIN_ANIMATION =
	/^(?:animate-(?:in|out)|(?:fade|zoom|spin)-(?:in|out)(?:-.+)?|slide-(?:in-from|out-to)-.+)$/;

// The media surrounds and swatches use fixed colours even when the app theme changes.
const ALLOWED_COLOURS: Readonly<Record<string, ReadonlySet<string>>> = {
	"packages/web/src/screens/MessageFiles.tsx": new Set(["max-md:bg-black"]),
	"packages/web/src/shell/SidebarProject.tsx": new Set(["text-black/80"]),
	"packages/website/src/landing/demo-video.tsx": new Set(["bg-black"]),
	"packages/website/src/docs/components/code-block.tsx": new Set([
		"bg-rose-400",
		"bg-yellow-400",
		"bg-green-400",
	]),
	"packages/website/src/components/accent.ts": new Set(
		["emerald", "sky", "orange", "pink", "purple"].flatMap((colour) => [
			`text-${colour}-600`,
			`dark:text-${colour}-400`,
		]),
	),
};

function utilityOf(token: string): string | undefined {
	let brackets = 0;
	let parentheses = 0;
	let start = 0;
	let quote: string | undefined;
	for (let index = 0; index < token.length; index++) {
		const character = token[index];
		if (character === "\\") {
			index++;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			continue;
		}
		if ((brackets > 0 || parentheses > 0) && (character === "'" || character === '"')) {
			quote = character;
			continue;
		}
		if (character === "[") brackets++;
		if (character === "]") brackets--;
		if (character === "(") parentheses++;
		if (character === ")") parentheses--;
		if (brackets < 0 || parentheses < 0) return undefined;
		if (character === ":" && brackets === 0 && parentheses === 0) start = index + 1;
	}
	if (brackets !== 0 || parentheses !== 0) return undefined;
	return token.slice(start).replace(/^!|!$/g, "");
}

/** tailwindValueViolations lists fixed class values and unavailable animation utilities in static class text. */
export function tailwindValueViolations(file: string, source: string) {
	const found: { token: string; line: number }[] = [];
	const allowedColours = Object.hasOwn(ALLOWED_COLOURS, file) ? ALLOWED_COLOURS[file] : undefined;
	const check = (literal: string, offset: number) => {
		for (const token of literal.split(/\s+/)) {
			const utility = utilityOf(token);
			if (!utility) continue;
			const colour = utility.split("/", 1)[0] ?? "";
			if (
				(file.startsWith(WEB_SOURCE) && PLUGIN_ANIMATION.test(utility)) ||
				BRACKETED_PROPERTY.test(utility) ||
				BRACKETED_VALUE.test(utility) ||
				(PALETTE_COLOUR.test(colour) && !allowedColours?.has(token))
			) {
				found.push({ token, line: source.slice(0, offset).split("\n").length });
			}
		}
	};
	new Visitor({
		Literal(node) {
			if (typeof node.value === "string") check(node.value, node.start);
		},
		TemplateLiteral(node) {
			for (const [index, part] of node.quasis.entries()) {
				const text = part.value.cooked;
				if (text === null || text === undefined) continue;
				// The pieces touching an interpolation are incomplete class tokens.
				const start = index === 0 ? text : text.replace(/^\S+/, "");
				check(part.tail ? start : start.replace(/\S+$/, ""), part.start);
			}
		},
	}).visit(parseSync(file, source).program);
	return found;
}

if (import.meta.main) {
	const root = resolve(import.meta.dirname, "..");
	for (const directory of SOURCE_DIRECTORIES) {
		const entries = readdirSync(join(root, directory), { recursive: true, withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
			const path = join(entry.parentPath, entry.name);
			const file = relative(root, path);
			for (const { token, line } of tailwindValueViolations(file, readFileSync(path, "utf8"))) {
				console.error(
					`${file}:${line}  ${token}  Use a defined Tailwind utility or a named CSS token.`,
				);
				process.exitCode = 1;
			}
		}
	}
}
