import { SugabotsMark } from "@sugabots/avatars";
import { cn } from "cn";
import { trackCallToActionClick } from "@/analytics";
import { DiscordIcon, GitHubIcon } from "@/components/brand-icons";
import { buttonVariants } from "@/components/ui/button";
import { siteLinks } from "@/site-links";

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
					<SugabotsMark className="size-6" />
					Sugabots
				</span>
				{/* On phones it takes a row of its own under the logo and links. */}
				<span className="order-last basis-full whitespace-nowrap sm:order-none sm:flex-1 sm:basis-auto">
					Open source, made by Nitric
				</span>
				<div className="ml-auto flex gap-5">
					<a
						href={siteLinks.docs}
						onClick={() => trackCallToActionClick("docs", "footer")}
						className={buttonVariants({ variant: "nav", size: "inline" })}
					>
						Docs
					</a>
					<a
						href={siteLinks.github}
						onClick={() => trackCallToActionClick("github", "footer")}
						aria-label="GitHub"
						className={buttonVariants({ variant: "nav", size: "inline" })}
					>
						<GitHubIcon className="size-5" />
					</a>
					<a
						href={siteLinks.discord}
						onClick={() => trackCallToActionClick("discord", "footer")}
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
