import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { CodeHighlighterPlugin } from "streamdown";

/* Streamdown declares its result type locally but doesn't export it; derive it from the plugin's own signature. */
type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;

/*
 * Streamdown's `code` plugin ships every Shiki grammar and a saturated GitHub
 * theme pair. In chat the grammars people actually paste are a handful, and
 * the saturated palette clashes with the monochrome bubble. This module loads
 * only the grammars Sugabots threads contain, under muted themes that sit
 * closer to the palette, and exposes it as the same `CodeHighlighterPlugin`
 * Streamdown expects.
 */

const LANGUAGES = [
	"typescript",
	"javascript",
	"python",
	"shell",
	"json",
	"markdown",
	"java",
	"go",
	"rust",
	"ruby",
	"sql",
	"yaml",
	"html",
	"css",
] as const;
type Language = (typeof LANGUAGES)[number];

/* Common fence tags that mean one of the loaded grammars. */
const ALIASES: Record<string, Language> = {
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	jsx: "javascript",
	py: "python",
	sh: "shell",
	bash: "shell",
	zsh: "shell",
	md: "markdown",
	rb: "ruby",
	yml: "yaml",
	golang: "go",
	rs: "rust",
};

function normalize(lang: string): Language | undefined {
	const key = lang.toLowerCase();
	const resolved = (ALIASES[key] ?? key) as Language;
	return (LANGUAGES as readonly string[]).includes(resolved) ? resolved : undefined;
}

/*
 * Streamdown's token classes read CSS variables with specific names:
 * `--sdm-c` for light-mode foreground, `--shiki-dark` for dark-mode foreground.
 * Shiki emits one variable per theme key under a shared prefix, so we name the
 * light theme `sdm-c` and the dark theme `shiki-dark` under the `--` prefix to
 * make the output land on exactly those names.
 */
const LIGHT_KEY = "sdm-c";
const DARK_KEY = "shiki-dark";
const THEMES = [LIGHT_KEY, DARK_KEY] as const satisfies [string, string];

const highlighterPromise: Promise<HighlighterCore> = createHighlighterCore({
	themes: [import("shiki/themes/min-light.mjs"), import("shiki/themes/min-dark.mjs")],
	langs: [
		import("shiki/langs/typescript.mjs"),
		import("shiki/langs/javascript.mjs"),
		import("shiki/langs/python.mjs"),
		import("shiki/langs/bash.mjs"),
		import("shiki/langs/json.mjs"),
		import("shiki/langs/markdown.mjs"),
		import("shiki/langs/java.mjs"),
		import("shiki/langs/go.mjs"),
		import("shiki/langs/rust.mjs"),
		import("shiki/langs/ruby.mjs"),
		import("shiki/langs/sql.mjs"),
		import("shiki/langs/yaml.mjs"),
		import("shiki/langs/html.mjs"),
		import("shiki/langs/css.mjs"),
	],
	engine: createJavaScriptRegexEngine(),
});

let ready: HighlighterCore | undefined;
highlighterPromise.then(
	(h) => {
		ready = h;
	},
	// A one-time init failure would otherwise leave `ready` undefined forever
	// and every fenced block silently fall back to plain mono; surface it as
	// a page error so a dev notices (and any error reporter plugged in sees it).
	(error) => {
		reportError(error);
	},
);

function highlight(h: HighlighterCore, code: string, lang: Language): HighlightResult {
	const result = h.codeToTokens(code, {
		lang,
		themes: { [LIGHT_KEY]: "min-light", [DARK_KEY]: "min-dark" },
		cssVariablePrefix: "--",
		defaultColor: false,
	});
	return {
		tokens: result.tokens as HighlightResult["tokens"],
		bg: result.bg,
		fg: result.fg,
		rootStyle: result.rootStyle,
	};
}

export const codeHighlighter: CodeHighlighterPlugin = {
	name: "shiki",
	type: "code-highlighter",
	getSupportedLanguages: () => [...LANGUAGES],
	getThemes: () => [...THEMES],
	supportsLanguage: (lang) => normalize(lang) !== undefined,
	highlight: (options, callback) => {
		const lang = normalize(options.language);
		if (!lang) return null;
		if (ready) return highlight(ready, options.code, lang);
		if (callback) {
			void highlighterPromise.then((h) => callback(highlight(h, options.code, lang)));
		}
		return null;
	},
};
