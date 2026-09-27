import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { BotAvatar } from "@/components/bot-avatar";
import type { DocPage } from "@/docs/pages";

function PageLink({ page, direction }: { page: DocPage; direction: "previous" | "next" }) {
	const isNext = direction === "next";
	return (
		<Link
			to="/docs/$slug"
			params={{ slug: page.slug }}
			className={cn(
				"group flex items-center gap-3 rounded-3xl bg-card p-4 ring-1 ring-foreground/10 transition hover:-translate-y-0.5 hover:shadow-lg",
				isNext && "flex-row-reverse text-right sm:col-start-2",
			)}
		>
			<BotAvatar
				size="lg"
				{...page.bot}
				className="transition-transform group-hover:rotate-6 group-hover:scale-110"
			/>
			<span className="flex min-w-0 flex-1 flex-col">
				<span
					className={cn(
						"flex items-center gap-1 text-xs font-semibold text-muted-foreground",
						isNext && "justify-end",
					)}
				>
					{isNext ? (
						<>
							Next <ArrowRightIcon className="size-3" />
						</>
					) : (
						<>
							<ArrowLeftIcon className="size-3" /> Previous
						</>
					)}
				</span>
				<span className="truncate font-bold">{page.title}</span>
			</span>
		</Link>
	);
}

/** The pages before and after this one, at its foot. */
export function PageLinks({ previous, next }: { previous?: DocPage; next?: DocPage }) {
	return (
		<nav aria-label="More docs" className="mt-20 grid gap-3 border-t pt-10 sm:grid-cols-2">
			{previous && <PageLink page={previous} direction="previous" />}
			{next && <PageLink page={next} direction="next" />}
		</nav>
	);
}
