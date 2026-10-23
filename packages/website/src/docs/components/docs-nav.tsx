import { Link, useLocation } from "@tanstack/react-router";
import { cn } from "cn";
import { MenuIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { accentText } from "@/components/accent";
import { docGroups } from "@/docs/nav";
import { findDocPage } from "@/docs/pages";

/** Every docs page, grouped. */
function DocsLinks() {
	return (
		<div className="flex flex-col gap-7">
			{docGroups.map((group) => (
				<section key={group.title} className="flex flex-col gap-2">
					<h2
						className={cn(
							"flex items-center gap-2 px-3 text-sm font-semibold",
							accentText({ tone: group.tone }),
						)}
					>
						<span className="size-2 rounded-full bg-current" />
						{group.title}
					</h2>
					<ul className="flex flex-col gap-0.5">
						{group.pages.map(({ slug }) => (
							<li key={slug}>
								<Link
									to="/docs/$slug"
									params={{ slug }}
									className="block rounded-full px-3 py-1.5 text-[0.95rem] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
									activeProps={{ className: "bg-secondary text-foreground font-semibold" }}
								>
									{findDocPage(slug)?.title}
								</Link>
							</li>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}

/** The page list beside the content, from large screens up. */
export function DocsSidebar() {
	return (
		<nav
			aria-label="Docs"
			className="sticky top-(--site-header-height) hidden max-h-[calc(100svh-var(--site-header-height))] w-60 shrink-0 overflow-y-auto py-10 pr-2 lg:block"
		>
			<DocsLinks />
		</nav>
	);
}

/** The page list behind a button, below large screens. */
export function DocsMenu() {
	const [open, setOpen] = useState(false);
	const pathname = useLocation({ select: (location) => location.pathname });

	// Following a link from the menu closes it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the page changes
	useEffect(() => setOpen(false), [pathname]);

	return (
		<div className="lg:hidden">
			{/* Drawn as the site header's own menu button, which this takes the place of in the docs. */}
			<button
				type="button"
				aria-label={open ? "Close the docs menu" : "Open the docs menu"}
				aria-expanded={open}
				onClick={() => setOpen((isOpen) => !isOpen)}
				className="ml-1 grid size-9 place-items-center rounded-[9px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
			>
				{open ? <XIcon className="size-5" /> : <MenuIcon className="size-5" />}
			</button>
			{open && (
				<nav
					aria-label="Docs"
					className="absolute inset-x-0 top-full max-h-[calc(100svh-var(--site-header-height))] overflow-y-auto border-b bg-background px-3 py-6 shadow-2xl"
				>
					<DocsLinks />
				</nav>
			)}
		</div>
	);
}
