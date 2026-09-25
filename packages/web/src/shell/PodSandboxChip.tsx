import type { PodSandboxStatus } from "@sugabots/contracts";
import { cn } from "cn";
import { SquareTerminal } from "lucide-react";
import { usePodSandbox } from "@/lib/sandbox-provider.ts";
import { Tooltip } from "@/ui/tooltip.tsx";

/*
 * Whether a pod's sandbox is up, beside the pod's name: a terminal mark with a
 * dot for its state. Nothing at all until an agent in the pod has needed one,
 * since most pods never will. The tooltip says who is using it, or when it was
 * last used.
 */
export function PodSandboxChip({ podId }: { podId: string }) {
	const { data: status } = usePodSandbox(podId);
	if (!status || status.state === "none") return null;
	const description = describe(status);
	return (
		<Tooltip label={description}>
			<span
				role="img"
				aria-label={description}
				className="flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-subtle-foreground"
			>
				<SquareTerminal aria-hidden size={14} strokeWidth={2} />
				<span
					aria-hidden
					className={cn(
						"size-1.5 rounded-full",
						status.state === "in_use" && "animate-pulse bg-success motion-reduce:animate-none",
						status.state === "idle" && "border border-muted-foreground/60",
						status.state === "paused" && "bg-muted-foreground/40",
						status.state === "lost" && "bg-warning",
					)}
				/>
			</span>
		</Tooltip>
	);
}

function describe(status: PodSandboxStatus): string {
	switch (status.state) {
		case "in_use":
			return `Sandbox in use by ${status.usedBy.map((agent) => `@${agent.handle}`).join(", ")}`;
		case "idle":
			return status.lastUsedAt
				? `Sandbox idle, last used ${sinceText(new Date(status.lastUsedAt))}`
				: "Sandbox idle";
		case "paused":
			return "Sandbox paused while nobody is using it. The next agent to need it wakes it.";
		case "lost":
			return "Sandbox lost: the provider no longer has it";
		case "none":
			return "No sandbox";
	}
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function sinceText(then: Date): string {
	const minutes = Math.round((then.getTime() - Date.now()) / 60_000);
	if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
	const hours = Math.round(minutes / 60);
	if (Math.abs(hours) < 24) return relative.format(hours, "hour");
	return relative.format(Math.round(hours / 24), "day");
}
