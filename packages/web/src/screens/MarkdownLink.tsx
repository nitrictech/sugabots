import type { Element } from "hast";
import { toString as hastToString } from "hast-util-to-string";
import { normalizeUri } from "micromark-util-sanitize-uri";
import { type MouseEvent, type ReactNode, useState } from "react";
import type { ExtraProps } from "streamdown";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog.tsx";

/**
 * MarkdownLink draws a link in a message's markdown as a real anchor, so
 * middle-click, Ctrl or Cmd-click and the browser's hover preview all work.
 * A plain click on a link off the app may ask first, showing the whole address;
 * see `asks`. A link back into the app opens without asking.
 */
export function MarkdownLink({
	href,
	node,
	asks,
	children,
}: ExtraProps & {
	href?: string;
	/**
	 * Which links off the app ask before opening. A bot's ask `always`, because
	 * a model's link text need not match where it goes, and a link written
	 * under a prompt injection can carry data out in its URL. A person's ask
	 * `unless-text-is-address`: one that shows where it goes opens at once.
	 */
	asks: "always" | "unless-text-is-address";
	children?: ReactNode;
}) {
	const [confirming, setConfirming] = useState(false);
	if (!href) return children;
	function askBeforeLeaving(event: MouseEvent<HTMLAnchorElement>) {
		if (!href || isInApp(href) || opensElsewhere(event)) return;
		if (asks === "unless-text-is-address" && showsItsAddress(node, href)) return;
		event.preventDefault();
		setConfirming(true);
	}
	return (
		<>
			<a href={href} target="_blank" rel="noreferrer" onClick={askBeforeLeaving}>
				{children}
			</a>
			<Dialog open={confirming} onOpenChange={setConfirming}>
				<DialogContent sheetOnPhone>
					<div className="flex flex-col gap-1.5">
						<DialogTitle>Open external link?</DialogTitle>
						<DialogDescription>You're about to visit a website outside Sugabots.</DialogDescription>
					</div>
					<p className="break-all rounded-md bg-chip p-2.5 font-mono text-xs">{href}</p>
					<div className="flex justify-end gap-2">
						<Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>
							Cancel
						</Button>
						<a
							href={href}
							target="_blank"
							rel="noreferrer"
							className={buttonStyles({ size: "sm" })}
							onClick={() => setConfirming(false)}
						>
							Open link
						</a>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}

/*
 * Whether a link's text is the address it goes to: written out in full, or a
 * bare `www.` or email address, which GFM links to with `http://` or `mailto:`
 * in front. The address was percent-encoded from the text by `normalizeUri`,
 * so the text is encoded the same way to compare them, or `café` never matches.
 */
function showsItsAddress(link: Element | undefined, href: string) {
	if (!link) return false;
	const text = hastToString(link);
	return [text, `http://${text}`, `mailto:${text}`].map(normalizeUri).includes(href);
}

function isInApp(href: string) {
	return URL.parse(href, window.location.href)?.origin === window.location.origin;
}

/* A middle or modified click is the reader choosing where the link opens, so it is theirs to make unasked. */
function opensElsewhere(event: MouseEvent) {
	return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}
