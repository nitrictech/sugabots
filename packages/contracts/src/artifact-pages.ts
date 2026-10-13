/*
 * How a bot-made HTML page is framed, wherever it is shown from: written into
 * a frame in the web app, or served from the installation's content origin.
 * Both must apply the same policy, report their height the same way and take
 * the same theme, so the pieces live here, beside each other.
 */

/** Inline code and styles, scripts from one CDN, and data the page embeds; nothing else fetched. */
export const PAGE_CONTENT_POLICY = [
	"default-src 'none'",
	"script-src 'unsafe-inline' https://cdn.jsdelivr.net",
	"style-src 'unsafe-inline'",
	"img-src data: blob:",
	"font-src data:",
	"media-src data: blob:",
	"form-action 'none'",
].join("; ");

/** The `type` of the message a page posts its parent with its height. */
export const PAGE_HEIGHT_MESSAGE = "sugabots:frame-height";

/**
 * Tells the parent the page's height whenever it changes. The page could post
 * the same message itself, which can only resize its own frame.
 */
export const PAGE_HEIGHT_REPORT = `<script>new ResizeObserver(() => parent.postMessage({ type: "${PAGE_HEIGHT_MESSAGE}", height: document.documentElement.scrollHeight }, "*")).observe(document.documentElement);</script>`;

/** The app's colour scheme and tokens, as `--name: value;` declarations, that a page is drawn with. */
export interface PageTheme {
	colorScheme: string;
	tokens: string;
}

/** The stylesheet a page gets its theme from, on a transparent ground. */
export function pageThemeCss({ colorScheme, tokens }: PageTheme): string {
	return `:root { color-scheme: ${colorScheme}; ${tokens} } html, body { background: transparent; } body { margin: 0; color: var(--body-foreground); font-family: var(--font-sans); }`;
}

/**
 * For a page served from the content origin: reads the theme from the
 * address's fragment, which never reaches the server, as `pageThemeCss`
 * builds it, and again whenever the fragment changes, as when the app's theme
 * does. The fragment is the JSON of a `PageTheme`, URI-encoded.
 */
export const PAGE_THEME_FROM_FRAGMENT = (() => {
	// `pageThemeCss` with the fragment's values spliced in where the page runs.
	// biome-ignore lint/suspicious/noTemplateCurlyInString: these become the page script's own template substitutions.
	const css = pageThemeCss({ colorScheme: "${theme.colorScheme}", tokens: "${theme.tokens}" });
	return `<script>(() => { const sheet = document.createElement("style"); const apply = () => { try { const theme = JSON.parse(decodeURIComponent(location.hash.slice(1))); sheet.textContent = \`${css}\`; } catch {} }; apply(); document.head.prepend(sheet); addEventListener("hashchange", apply); })();</script>`;
})();

/**
 * `html` with `tags` before any of the page's own, so a policy among them
 * applies before anything else: the parser puts leading `<meta>`, `<style>`
 * and `<script>` tags in the head it opens. It is not looked for a `<head>`
 * to go in, since the page could hide one in a comment. They go after a
 * doctype rather than before, which would put the page in quirks mode.
 */
export function withLeadingTags(html: string, tags: string): string {
	const doctype = /^<!doctype[^>]*>/i.exec(html.trimStart());
	if (!doctype) return `${tags}${html}`;
	const rest = html.trimStart().slice(doctype[0].length);
	return `${doctype[0]}${tags}${rest}`;
}
