import { cn } from "cn";
import { DiscordIcon, GitHubIcon } from "@/components/brand-icons";
import { SiteLogo } from "@/components/site-logo";
import { buttonVariants } from "@/components/ui/button";
import { launched, siteLinks } from "@/site-links";

/** The footer's content width, matched to the page above it. */
const footerWidth = {
	narrow: "max-w-3xl",
	wide: "max-w-7xl",
};

export function SiteFooter({ width = "narrow" }: { width?: keyof typeof footerWidth }) {
	return (
		<footer className="border-t">
			<div
				className={cn(
					"mx-auto flex flex-wrap items-center gap-4 px-6 py-7 text-sm text-muted-foreground",
					footerWidth[width],
				)}
			>
				<span className="flex items-center gap-2 text-base font-extrabold tracking-tight text-foreground">
					<SiteLogo className="size-6" />
					Sugabots
				</span>
				<span className="flex-1 whitespace-nowrap">Open source, made by Nitric</span>
				<div className="flex gap-5">
					{launched && (
						<>
							<a
								href={siteLinks.docs}
								className={buttonVariants({ variant: "nav", size: "inline" })}
							>
								Docs
							</a>
							<a
								href={siteLinks.github}
								aria-label="GitHub"
								className={buttonVariants({ variant: "nav", size: "inline" })}
							>
								<GitHubIcon className="size-5" />
							</a>
						</>
					)}
					<a
						href={siteLinks.discord}
						aria-label="Discord"
						className={buttonVariants({ variant: "nav", size: "inline" })}
					>
						<DiscordIcon className="size-5" />
					</a>
				</div>
			</div>
		</footer>
	);
}
