import type { CodeHighlighterPlugin } from "streamdown";

/* Streamdown declares its result type locally but doesn't export it; derive it from the plugin's own signature. */
type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;

/*
 * Fenced code is highlighted with Pierre's Highlights, which tokenizes
 * synchronously and also offers a tokenizer that keeps its state as code
 * streams in. Its muted themes sit closer to the monochrome bubble than
 * Streamdown's saturated GitHub pair.
 */

/*
 * Streamdown's token classes read CSS variables with specific names:
 * `--sdm-c` for light-mode foreground, `--shiki-dark` for dark-mode foreground.
 * Highlights emits one variable per theme key under a shared prefix, so we
 * name the light theme `sdm-c` and the dark theme `shiki-dark` under the `--`
 * prefix to make the output land on exactly those names.
 */
const LIGHT_KEY = "sdm-c";
const DARK_KEY = "shiki-dark";

/*
 * The highlighter is a WebAssembly module of a few hundred kilobytes, so it is
 * fetched the first time a message contains fenced code rather than with the app.
 */
async function importHighlighter() {
	const [{ codeToTokens, isSupportedLanguage }, { minLight, minDark }] = await Promise.all([
		import("@pierre/highlights"),
		import("@pierre/highlights/themes"),
	]);
	return {
		isSupportedLanguage,
		/** Null for a language Highlights has no lexer for. */
		highlight: (code: string, lang: string): HighlightResult | null => {
			if (!isSupportedLanguage(lang)) return null;
			return codeToTokens(code, {
				lang,
				themes: { [LIGHT_KEY]: minLight, [DARK_KEY]: minDark },
				cssVariablePrefix: "--",
				defaultColor: false,
			});
		},
	};
}
type Highlighter = Awaited<ReturnType<typeof importHighlighter>>;

let ready: Highlighter | undefined;
let loading: Promise<Highlighter | undefined> | undefined;

/* Resolves to undefined if the import fails, leaving code plain; the failure is reported once. */
function loadHighlighter(): Promise<Highlighter | undefined> {
	loading ??= importHighlighter().then(
		(highlighter) => {
			ready = highlighter;
			return highlighter;
		},
		(error) => {
			reportError(error);
			return undefined;
		},
	);
	return loading;
}

export const codeHighlighter: CodeHighlighterPlugin = {
	name: "shiki",
	type: "code-highlighter",
	// Streamdown calls neither of these; `highlight` returning null leaves the block as plain text.
	getSupportedLanguages: () => [],
	supportsLanguage: (lang) => ready?.isSupportedLanguage(lang) ?? false,
	getThemes: () => [LIGHT_KEY, DARK_KEY],
	highlight: ({ code, language }, callback) => {
		if (ready) return ready.highlight(code, language);
		void loadHighlighter().then((highlighter) => {
			const result = highlighter?.highlight(code, language);
			if (result) callback?.(result);
		});
		return null;
	},
};
