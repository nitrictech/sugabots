import { SiteLogo } from "@/components/site-logo";
import { Button } from "@/components/ui/button";
import { launched, siteLinks } from "@/site-links";

export function SiteFooter() {
	return (
		<footer className="border-t">
			<div className="mx-auto flex max-w-3xl flex-wrap items-center gap-4 px-6 py-7 text-sm text-muted-foreground">
				<span className="flex items-center gap-2 text-base font-extrabold tracking-tight text-foreground">
					<SiteLogo className="size-6" />
					Sugabots
				</span>
				<span className="flex-1 whitespace-nowrap">Open source, made by Nitric</span>
				<div className="flex gap-5">
					{launched && (
						<>
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
						</>
					)}
					<Button
						variant="nav"
						size="inline"
						nativeButton={false}
						render={<a href={siteLinks.discord} />}
					>
						Discord
					</Button>
				</div>
			</div>
		</footer>
	);
}
