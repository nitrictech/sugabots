import { Link } from "@tanstack/react-router";
import { trackCallToActionClick } from "@/analytics";
import { DiscordIcon, GitHubIcon } from "@/components/brand-icons";
import { SiteLogo } from "@/components/site-logo";
import { buttonVariants } from "@/components/ui/button";
import { DocsMenu } from "@/docs/components/docs-nav";
import { siteLinks } from "@/site-links";

export function DocsHeader() {
	return (
		<header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur-md">
			<nav className="mx-auto flex max-w-7xl items-center gap-5 px-6 py-3">
				<Link to="/" className="flex items-center gap-2 text-xl font-extrabold tracking-tight">
					<SiteLogo className="size-8" />
					Sugabots
				</Link>
				<Link
					to="/docs"
					className="-ml-2 rounded-full bg-secondary px-2.5 py-0.5 text-sm font-bold text-secondary-foreground"
				>
					Docs
				</Link>
				<div className="flex flex-1 justify-end gap-5">
					<a
						href={siteLinks.github}
						onClick={() => trackCallToActionClick("github", "docs_header")}
						aria-label="GitHub"
						className={buttonVariants({ variant: "nav", size: "inline" })}
					>
						<GitHubIcon className="size-5" />
					</a>
					<a
						href={siteLinks.discord}
						onClick={() => trackCallToActionClick("discord", "docs_header")}
						aria-label="Discord"
						className={buttonVariants({ variant: "nav", size: "inline" })}
					>
						<DiscordIcon className="size-5" />
					</a>
				</div>
				<DocsMenu />
			</nav>
		</header>
	);
}
