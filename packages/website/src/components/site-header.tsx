import { SugabotsMark } from "@sugabots/avatars";
import { cn } from "cn";
import { MenuIcon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { type CallToActionPlacement, trackCallToActionClick } from "@/analytics";
import { DiscordIcon, GitHubIcon } from "@/components/brand-icons";
import { callToAction } from "@/landing/call-to-action";
import { siteColumn } from "@/layout";
import { siteLinks } from "@/site-links";

/**
 * The header's colours: the visitor's colour scheme, as the docs and guides
 * follow it, or inside a `data-landing` page, the landing page's dark UI.
 */
const colours = {
	bar: "border-border bg-background/82 in-data-landing:border-landing-line in-data-landing:bg-landing-page/82",
	text: "text-foreground in-data-landing:text-landing-text",
	link: "text-muted-foreground hover:bg-muted hover:text-foreground in-data-landing:text-landing-muted in-data-landing:hover:bg-landing-bubble in-data-landing:hover:text-landing-text",
	divider: "bg-border in-data-landing:bg-landing-frame",
	panel:
		"border-border bg-background in-data-landing:border-landing-line in-data-landing:bg-landing-page",
	waitlist: cn(
		callToAction({ variant: "quiet", size: "small" }),
		"text-foreground hover:bg-muted hover:text-foreground in-data-landing:text-landing-button-text in-data-landing:hover:bg-landing-bubble in-data-landing:hover:text-white",
	),
	menuWaitlist: cn(
		callToAction({ variant: "secondary" }),
		"border-input text-foreground hover:border-ring hover:text-foreground in-data-landing:border-landing-control in-data-landing:text-landing-button-text in-data-landing:hover:border-landing-control-hover in-data-landing:hover:text-white",
	),
};

interface SiteHeaderProps {
	/** Where its clicks are counted as coming from. */
	placement: CallToActionPlacement;
	/** The page is in the docs, where the badge stands in for the Docs link. */
	inDocs?: boolean;
	/** A label beside the logo, linking to the section's start: Docs, in the docs. */
	badge?: { label: string; href: string };
	/** Where the logo leads: the top of the page, on the landing page. */
	homeHref?: string;
	/** What the menu button opens on small screens, in place of the site's links: the docs' page list. */
	menu?: ReactNode;
}

/** Every page's header: the logo, Docs, and the calls to action, with a line under it. */
export function SiteHeader({
	placement,
	inDocs = false,
	badge,
	homeHref = "/",
	menu,
}: SiteHeaderProps) {
	const track = (cta: Parameters<typeof trackCallToActionClick>[0]) => () =>
		trackCallToActionClick(cta, placement);
	const iconButton = cn(
		"grid size-9 place-items-center rounded-[9px] opacity-75 transition-[opacity,background-color] hover:opacity-100",
		colours.text,
		colours.link,
	);

	return (
		<header className={cn("sticky top-0 z-20 border-b backdrop-blur-md", colours.bar)}>
			<nav
				aria-label="Main navigation"
				className={cn(
					"relative mx-auto flex h-(--site-header-height) items-center gap-6",
					siteColumn,
				)}
			>
				<div className="flex items-center gap-2.5">
					<a href={homeHref} className={cn("flex items-center gap-2.5", colours.text)}>
						<SugabotsMark className="size-[30px]" />
						<span className="text-lg font-bold tracking-[-0.01em]">Sugabots</span>
					</a>
					{badge && (
						<a
							href={badge.href}
							className="rounded-full bg-secondary px-2.5 py-0.5 text-sm font-bold text-secondary-foreground"
						>
							{badge.label}
						</a>
					)}
				</div>
				{!inDocs && (
					<a
						href={siteLinks.docs}
						onClick={track("docs")}
						className={cn(
							"ml-3 hidden rounded-lg px-3 py-2 text-sm font-medium lg:block",
							colours.link,
						)}
					>
						Docs
					</a>
				)}
				<span className="flex-1" />
				<div className="flex items-center gap-1.5">
					<a
						href={siteLinks.github}
						onClick={track("github")}
						aria-label="GitHub"
						className={iconButton}
					>
						<GitHubIcon className="size-[18px]" />
					</a>
					<a
						href={siteLinks.discord}
						onClick={track("discord")}
						aria-label="Discord"
						className={iconButton}
					>
						<DiscordIcon className="size-[18px]" />
					</a>
					<span className={cn("mx-2.5 hidden h-5 w-px lg:block", colours.divider)} />
					<a
						href={siteLinks.waitlist}
						onClick={track("waitlist")}
						className={cn(colours.waitlist, "hidden lg:inline-flex")}
					>
						Join the waitlist
					</a>
					<a
						href={siteLinks.selfHost}
						onClick={track("self_host")}
						className={cn(callToAction({ size: "small" }), "hidden lg:inline-flex")}
					>
						Self-host
					</a>
					{menu ?? <SiteMenu buttonClassName={iconButton} track={track} />}
				</div>
			</nav>
		</header>
	);
}

/** Docs and the calls to action behind a button, on screens too narrow to show them in one row with the logo. */
function SiteMenu({
	buttonClassName,
	track,
}: {
	buttonClassName: string;
	track: (cta: Parameters<typeof trackCallToActionClick>[0]) => () => void;
}) {
	const [open, setOpen] = useState(false);
	const close = (then?: () => void) => () => {
		then?.();
		setOpen(false);
	};

	return (
		<div className="lg:hidden">
			<button
				type="button"
				aria-label={open ? "Close the menu" : "Open the menu"}
				aria-expanded={open}
				onClick={() => setOpen((isOpen) => !isOpen)}
				className={cn(buttonClassName, "ml-1 opacity-100")}
			>
				{open ? <XIcon className="size-5" /> : <MenuIcon className="size-5" />}
			</button>
			{open && (
				<div
					className={cn(
						"absolute inset-x-0 top-full flex flex-col gap-1 border-b px-3 py-4 shadow-2xl",
						colours.panel,
					)}
				>
					<a
						href={siteLinks.docs}
						onClick={close(track("docs"))}
						className={cn("rounded-lg px-3 py-2.5 font-medium", colours.link)}
					>
						Docs
					</a>
					<a
						href={siteLinks.waitlist}
						onClick={close(track("waitlist"))}
						className={cn(colours.menuWaitlist, "mt-2")}
					>
						Join the waitlist
					</a>
					<a
						href={siteLinks.selfHost}
						onClick={close(track("self_host"))}
						className={cn(callToAction(), "mt-2")}
					>
						Self-host
					</a>
				</div>
			)}
		</div>
	);
}
