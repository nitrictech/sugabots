import { MenuIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { trackCallToActionClick } from "@/analytics";
import { DiscordIcon, GitHubIcon } from "@/components/brand-icons";
import { SiteLogo } from "@/components/site-logo";
import { Button, buttonVariants } from "@/components/ui/button";
import { siteLinks } from "@/site-links";

export function SiteHeader() {
	return (
		<header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur-md">
			<nav className="mx-auto flex max-w-3xl items-center gap-4 px-6 py-3 sm:gap-6">
				<a href="#top" className="flex items-center gap-2 text-xl font-extrabold tracking-tight">
					<SiteLogo className="size-8" />
					Sugabots
				</a>
				<a
					href={siteLinks.docs}
					onClick={() => trackCallToActionClick("docs", "header")}
					className={buttonVariants({
						variant: "nav",
						size: "inline",
						className: "hidden sm:inline-flex",
					})}
				>
					Docs
				</a>
				<div className="ml-auto flex gap-4 sm:gap-5">
					<a
						href={siteLinks.github}
						onClick={() => trackCallToActionClick("github", "header")}
						aria-label="GitHub"
						className={buttonVariants({ variant: "nav", size: "inline" })}
					>
						<GitHubIcon className="size-5" />
					</a>
					<a
						href={siteLinks.discord}
						onClick={() => trackCallToActionClick("discord", "header")}
						aria-label="Discord"
						className={buttonVariants({ variant: "nav", size: "inline" })}
					>
						<DiscordIcon className="size-5" />
					</a>
				</div>
				<div className="hidden sm:block">
					<a
						href={siteLinks.getStarted}
						onClick={() => trackCallToActionClick("get_started", "header")}
						className={buttonVariants()}
					>
						Get started
					</a>
				</div>
				<SiteMenu />
			</nav>
		</header>
	);
}

/**
 * Docs and "Get started" behind a button, on phones, where they don't fit in
 * one row with the logo and the icons.
 */
function SiteMenu() {
	const [open, setOpen] = useState(false);

	return (
		<div className="sm:hidden">
			<Button
				variant="outline"
				size="icon"
				aria-label={open ? "Close the menu" : "Open the menu"}
				aria-expanded={open}
				onClick={() => setOpen((isOpen) => !isOpen)}
			>
				{open ? <XIcon /> : <MenuIcon />}
			</Button>
			{open && (
				<div className="absolute inset-x-0 top-full flex flex-col gap-1 border-b bg-background px-3 py-4 shadow-2xl">
					<a
						href={siteLinks.docs}
						onClick={() => {
							trackCallToActionClick("docs", "header");
							setOpen(false);
						}}
						className="rounded-full px-3 py-2 font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
					>
						Docs
					</a>
					<a
						href={siteLinks.getStarted}
						onClick={() => {
							trackCallToActionClick("get_started", "header");
							setOpen(false);
						}}
						className={buttonVariants({ className: "mt-2" })}
					>
						Get started
					</a>
				</div>
			)}
		</div>
	);
}
