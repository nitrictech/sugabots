import { SugabotsMark } from "@sugabots/avatars";
import { cn } from "cn";
import type { ReactNode } from "react";
import { type CallToAction, trackCallToActionClick } from "@/analytics";
import { DiscordIcon, GitHubIcon } from "@/components/brand-icons";
import { siteColumn } from "@/layout";
import { siteLinks } from "@/site-links";

/**
 * The footer's colours: the visitor's colour scheme, as the docs and guides
 * follow it, or inside a `data-landing` page, the landing page's dark UI.
 */
const colours = {
	line: "border-border in-data-landing:border-landing-line",
	text: "text-foreground in-data-landing:text-landing-text",
	heading: "text-muted-foreground in-data-landing:text-landing-faint",
	link: "text-muted-foreground hover:text-foreground in-data-landing:text-landing-secondary in-data-landing:hover:text-landing-text",
	fineprint:
		"text-muted-foreground in-data-landing:text-landing-faint [&_a]:hover:text-foreground in-data-landing:[&_a]:hover:text-landing-text",
	iconLink:
		"border-border text-muted-foreground hover:border-ring hover:text-foreground in-data-landing:border-landing-line in-data-landing:text-landing-muted in-data-landing:hover:border-landing-control in-data-landing:hover:text-landing-text",
};

interface FooterLink {
	label: string;
	href: string;
	/** Counted as a click on this call to action. */
	cta?: CallToAction;
}

const columns: readonly { title: string; links: readonly FooterLink[] }[] = [
	{
		title: "Product",
		links: [
			{ label: "Docs", href: siteLinks.docs, cta: "docs" },
			{ label: "Quickstart", href: siteLinks.selfHost, cta: "self_host" },
			{ label: "Join the waitlist", href: siteLinks.waitlist, cta: "waitlist" },
		],
	},
	{
		title: "Community",
		links: [
			{ label: "GitHub", href: siteLinks.github, cta: "github" },
			{ label: "Discord", href: siteLinks.discord, cta: "discord" },
		],
	},
];

const LICENSE_URL = `${siteLinks.github}/blob/main/LICENSE.md`;

interface SiteFooterProps {
	/** Where the logo leads: the top of the page, on the landing page. */
	homeHref?: string;
}

/** Every page's footer: the logo, the site in columns, and the licence. */
export function SiteFooter({ homeHref = "/" }: SiteFooterProps) {
	return (
		<footer className={cn("border-t", colours.line)}>
			<div className={cn(siteColumn, "flex flex-col gap-14 pt-16 pb-10 text-sm")}>
				<div className="flex flex-col gap-12 md:flex-row md:justify-between">
					<div className="flex max-w-xs flex-col gap-4">
						<a href={homeHref} className={cn("flex items-center gap-2.5 self-start", colours.text)}>
							<SugabotsMark className="size-7" />
							<span className="text-[17px] font-bold tracking-[-0.01em]">Sugabots</span>
						</a>
						<div className="flex gap-1.5">
							<IconLink href={siteLinks.github} label="GitHub" cta="github">
								<GitHubIcon className="size-[17px]" />
							</IconLink>
							<IconLink href={siteLinks.discord} label="Discord" cta="discord">
								<DiscordIcon className="size-[17px]" />
							</IconLink>
						</div>
					</div>
					<nav aria-label="Footer" className="grid grid-cols-2 gap-x-16 gap-y-10">
						{columns.map((column) => (
							<div key={column.title} className="flex flex-col gap-3.5">
								<h2 className={cn("text-sm font-medium", colours.heading)}>{column.title}</h2>
								{column.links.map(({ label, href, cta }) => (
									<a
										key={label}
										href={href}
										onClick={cta ? () => trackCallToActionClick(cta, "footer") : undefined}
										className={cn("self-start transition-colors", colours.link)}
									>
										{label}
									</a>
								))}
							</div>
						))}
					</nav>
				</div>
				<div
					className={cn(
						"flex flex-wrap justify-between gap-x-6 gap-y-2 border-t pt-6 text-[13px]",
						colours.line,
						colours.fineprint,
					)}
				>
					<a href={LICENSE_URL}>MIT licensed</a>
					<span>© 2026 Nitric Group Inc.</span>
				</div>
			</div>
		</footer>
	);
}

function IconLink({
	href,
	label,
	cta,
	children,
}: {
	href: string;
	label: string;
	cta: CallToAction;
	children: ReactNode;
}) {
	return (
		<a
			href={href}
			aria-label={label}
			onClick={() => trackCallToActionClick(cta, "footer")}
			className={cn(
				"grid size-9 place-items-center rounded-full border transition-colors",
				colours.iconLink,
			)}
		>
			{children}
		</a>
	);
}
