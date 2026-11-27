import type { Element } from "hast";
import { toString as hastToString } from "hast-util-to-string";
import { ImageIcon } from "lucide-react";
import { normalizeUri } from "micromark-util-sanitize-uri";
import { type ComponentProps, type MouseEvent, type ReactNode, useState } from "react";
import type { ExtraProps } from "streamdown";
import { isPlainClick } from "@/ui/back-button.tsx";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog.tsx";
import { FileRow } from "@/ui/file-row.tsx";
import { IconTile } from "@/ui/icon-tile.tsx";

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
	 * under a prompt injection can carry data out in its URL. A member's ask
	 * `unless-text-is-address`: one that shows where it goes opens at once.
	 */
	asks: "always" | "unless-text-is-address";
	children?: ReactNode;
}) {
	if (!href) return children;
	const addressShown = asks === "unless-text-is-address" && showsItsAddress(node, href);
	return (
		<AnchorThatAsks href={href} asks={!addressShown} wording={LINK_WORDING}>
			{children}
		</AnchorThatAsks>
	);
}

/**
 * MarkdownImageLink draws an image that wasn't loaded as a card linking to it,
 * naming it by its words and the site it is on. A plain click on one off the
 * app always asks first, as the card cuts its address short.
 */
export function MarkdownImageLink({
	href,
	children,
}: ExtraProps & {
	href?: string;
	/** The image's alt text, or else its address. */
	children?: ReactNode;
}) {
	if (!href) return children;
	return (
		<FileRow
			look="card"
			render={
				<AnchorThatAsks
					href={href}
					asks
					wording={IMAGE_WORDING}
					// `app.css` takes a message link's underline and colour off the card by this.
					data-image-link=""
				/>
			}
			className="focus-ring my-1 inline-flex max-w-full align-middle hover:border-border-strong"
			icon={
				<IconTile size="md" tone="tile">
					<ImageIcon />
				</IconTile>
			}
			title={children}
			subtitle={`Image from ${URL.parse(href, window.location.href)?.host ?? href}`}
		/>
	);
}

/** What the dialog says before a link off the app opens. */
interface Wording {
	title: string;
	description: string;
	open: string;
}

const LINK_WORDING: Wording = {
	title: "Open external link?",
	description: "You're about to visit a website outside Sugabots.",
	open: "Open link",
};

const IMAGE_WORDING: Wording = {
	title: "Open image?",
	description: "You're about to open an image from a website outside Sugabots.",
	open: "Open image",
};

/**
 * AnchorThatAsks draws a real anchor to `href`, opening in a new tab. When
 * `asks`, a plain click on it off the app shows `wording` and the whole
 * address first; a link back into the app opens without asking.
 */
function AnchorThatAsks({
	href,
	asks,
	wording,
	children,
	...anchor
}: Omit<ComponentProps<"a">, "href" | "target" | "rel" | "onClick"> & {
	href: string;
	asks: boolean;
	wording: Wording;
}) {
	const [confirming, setConfirming] = useState(false);
	function askBeforeLeaving(event: MouseEvent<HTMLAnchorElement>) {
		// A middle or modified click is the reader choosing where the link opens, so it is theirs to make unasked.
		if (!asks || isInApp(href) || !isPlainClick(event)) return;
		event.preventDefault();
		setConfirming(true);
	}
	return (
		<>
			<a {...anchor} href={href} target="_blank" rel="noreferrer" onClick={askBeforeLeaving}>
				{children}
			</a>
			<Dialog open={confirming} onOpenChange={setConfirming}>
				<DialogContent sheetOnPhone>
					<div className="flex flex-col gap-1.5">
						<DialogTitle>{wording.title}</DialogTitle>
						<DialogDescription>{wording.description}</DialogDescription>
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
							{wording.open}
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
