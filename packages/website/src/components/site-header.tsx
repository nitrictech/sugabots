import { SiteLogo } from "@/components/site-logo";
import { Button } from "@/components/ui/button";
import { siteLinks } from "@/site-links";

export function SiteHeader() {
	return (
		<header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur-md">
			<nav className="mx-auto flex max-w-3xl items-center gap-6 px-6 py-3">
				<a href="#top" className="flex items-center gap-2 text-xl font-extrabold tracking-tight">
					<SiteLogo className="size-8" />
					Sugabots
				</a>
				<div className="flex flex-1 gap-5">
					<Button
						variant="nav"
						size="inline"
						nativeButton={false}
						render={<a href={siteLinks.docs} />}
					>
						Docs
					</Button>
					<Button
						variant="nav"
						size="inline"
						nativeButton={false}
						render={<a href={siteLinks.github} />}
					>
						GitHub
					</Button>
				</div>
				<Button nativeButton={false} render={<a href={siteLinks.getStarted} />}>
					Get started
				</Button>
			</nav>
		</header>
	);
}
