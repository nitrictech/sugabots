import { cn } from "cn";

/**
 * A bot-written HTML page, shown so that nothing in it can act as the viewer.
 *
 * The page is written by a model, and a model can be steered by anything it
 * read, so it is treated as hostile. `sandbox` without `allow-same-origin`
 * gives the frame an opaque origin: its scripts run, but cannot read the app's
 * cookies or storage or call the API as the viewer. The policy below then
 * stops it loading or sending anything over the network. A frame can still
 * navigate itself, which could carry what the page holds out in a URL; that
 * is the page's own content, nothing of the viewer's.
 */
export function HtmlFrame({
	html,
	title,
	className,
}: {
	html: string;
	title: string;
	className?: string;
}) {
	return (
		<iframe
			title={title}
			srcDoc={withContentPolicy(html)}
			sandbox="allow-scripts"
			referrerPolicy="no-referrer"
			className={cn("block w-full border-0 bg-white", className)}
		/>
	);
}

/** Inline code and styles, and data the page embeds; nothing fetched from anywhere. */
export const FRAME_CONTENT_POLICY = [
	"default-src 'none'",
	"script-src 'unsafe-inline'",
	"style-src 'unsafe-inline'",
	"img-src data: blob:",
	"font-src data:",
	"media-src data: blob:",
	"form-action 'none'",
].join("; ");

const POLICY_TAG = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CONTENT_POLICY}">`;

/**
 * `html` with the policy before anything else in it, so it applies before any
 * of the page's own tags: the parser puts a leading `<meta>` in the head it
 * opens. It is not looked for a `<head>` to go in, since the page could hide
 * one in a comment. It goes after a doctype rather than before, which would put
 * the page in quirks mode.
 */
export function withContentPolicy(html: string): string {
	const doctype = /^<!doctype[^>]*>/i.exec(html.trimStart());
	if (!doctype) return `${POLICY_TAG}${html}`;
	const rest = html.trimStart().slice(doctype[0].length);
	return `${doctype[0]}${POLICY_TAG}${rest}`;
}
