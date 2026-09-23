import { Check, Copy, Wrench } from "lucide-react";
import { useState } from "react";
import type { ConnectionLook } from "@/lib/connections.ts";
import { IconButton } from "@/ui/icon-button.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { ToolActivityDialog } from "./ToolActivityDialog.tsx";
import type { ToolActivity } from "./tool-activity.ts";

/*
 * The bar that appears beside the top of an agent's reply on hover, and on
 * focus for anyone using a keyboard. With tool calls left out of the thread entirely,
 * the wrench and its step count are the only way to what the agent did, so
 * this cannot be hover-only in the literal sense: it is transparent until the
 * pointer or the focus reaches it, never removed.
 */

export function MessageActions({
	text,
	activity,
	looks,
	at,
}: {
	/** The reply's text, for the copy action. */
	text: string;
	activity: ToolActivity;
	looks?: ReadonlyMap<string, ConnectionLook>;
	at?: string;
}) {
	const [copied, setCopied] = useState(false);
	const [logOpen, setLogOpen] = useState(false);
	const steps = activity.stepCount;
	return (
		<div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border-subtle bg-card p-0.5 opacity-0 shadow-row transition-opacity focus-within:opacity-100 group-hover/message:opacity-100">
			<IconButton
				label={copied ? "Copied" : "Copy message"}
				size="sm"
				onClick={() => {
					void navigator.clipboard?.writeText(text);
					setCopied(true);
				}}
			>
				{copied ? <Check aria-hidden /> : <Copy aria-hidden />}
			</IconButton>
			{steps > 0 && (
				<>
					{/*
					 * Not an IconButton: that one is sized for an icon alone, and this
					 * carries the step count beside the wrench as the design has it.
					 */}
					<Tooltip label={`Show activity · ${steps} ${steps === 1 ? "step" : "steps"}`}>
						<button
							type="button"
							aria-label={`Show activity · ${steps} ${steps === 1 ? "step" : "steps"}`}
							onClick={() => setLogOpen(true)}
							className="focus-ring flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-surface-muted-foreground transition-colors hover:bg-surface-accent hover:text-surface-accent-foreground"
						>
							<Wrench className="size-3.5" aria-hidden />
							<span className="font-semibold text-2xs">{steps}</span>
						</button>
					</Tooltip>
					<ToolActivityDialog
						activity={activity}
						looks={looks}
						at={at}
						open={logOpen}
						onOpenChange={setLogOpen}
					/>
				</>
			)}
		</div>
	);
}
