import { cn } from "cn";
import type { ReactNode } from "react";
import { AgentAvatar } from "@/shell/Agent.tsx";

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
	children,
}: {
	title: ReactNode;
	subtitle?: ReactNode;
	/** `wide` for the workspace tools, which list things rather than ask one question. */
	size?: "default" | "wide";
	children: ReactNode;
}) {
	return (
		<div className="grid h-full place-items-center overflow-auto bg-sunken p-8">
			<div
				className={cn("flex w-full flex-col gap-3.5", size === "wide" ? "max-w-105" : "max-w-80")}
			>
				<div className="flex items-center gap-2.5">
					{/*
					 * The wordmark is an agent's face in the heading colour rather than
					 * a hue: the product mark is not one of the agents.
					 */}
					<AgentAvatar hue={265} face="bar" size={26} className="[--agent-avatar:var(--heading)]" />
					<span className="font-semibold text-heading text-xl">Sugabots</span>
				</div>
				<div>
					<h1 className="font-semibold text-3xl text-heading">{title}</h1>
					{subtitle !== undefined && (
						<p className="pt-1 text-md text-muted-foreground leading-relaxed">{subtitle}</p>
					)}
				</div>
				{children}
			</div>
		</div>
	);
}
