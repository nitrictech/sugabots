import { cn } from "cn";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The centred card the pages outside the shell sit on: log in, accept an
 * invitation, set a workspace up. There is no sidebar to be had on any of them
 * — you are not in a workspace yet — so they get their own frame.
 *
 * The fields inside come from `@/ui/field` and the errors from `@/ui/alert`,
 * the same ones the agent editor and settings forms will use.
 */
export function AuthLayout({
	title,
	subtitle,
	size = "default",
	onBack,
	children,
}: {
	title: ReactNode;
	subtitle?: ReactNode;
	/** `wide` for the workspace tools, which list things rather than ask one question. */
	size?: "default" | "wide";
	/** A way back to the page before, such as the welcome. */
	onBack?: () => void;
	children: ReactNode;
}) {
	return (
		<div className="flex h-full flex-col overflow-auto bg-background text-foreground">
			<header className="shrink-0 px-8 pt-7 max-md:px-4">
				{onBack && (
					<button
						type="button"
						onClick={onBack}
						className="focus-ring inline-flex items-center gap-0.5 rounded-md font-medium text-[14.5px] text-link"
					>
						<ChevronLeft aria-hidden size={16} strokeWidth={2.4} />
						Back
					</button>
				)}
			</header>
			<div className="grid flex-1 place-items-center px-4 py-10">
				<div
					className={cn(
						"flex w-full flex-col gap-3.5",
						size === "wide" ? "max-w-[520px]" : "max-w-[440px]",
					)}
				>
					<div className="flex flex-col gap-2.5 pb-2 text-center">
						<h1 className="m-0 text-balance font-bold text-[30px] leading-[1.15] tracking-[-0.02em]">
							{title}
						</h1>
						{subtitle !== undefined && (
							<p className="m-0 text-pretty text-[15px] text-muted-foreground leading-[1.55]">
								{subtitle}
							</p>
						)}
					</div>
					{children}
				</div>
			</div>
		</div>
	);
}
