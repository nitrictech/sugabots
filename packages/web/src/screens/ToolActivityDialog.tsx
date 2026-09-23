import { useId } from "react";
import type { ConnectionLook } from "@/lib/connections.ts";
import { Dialog, DialogContent } from "@/ui/dialog.tsx";
import { ToolActivityLog } from "./ToolActivityLog.tsx";
import type { ToolActivity } from "./tool-activity.ts";

/*
 * Where the activity log opens from a message. A dialog rather than a docked
 * panel for now: the log itself knows nothing about this, so moving it into a
 * panel beside the thread later is a change here and nowhere else.
 */

export function ToolActivityDialog({
	activity,
	looks,
	at,
	open,
	onOpenChange,
}: {
	activity: ToolActivity;
	looks?: ReadonlyMap<string, ConnectionLook>;
	at?: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const headingId = useId();
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				aria-labelledby={headingId}
				className="flex h-[min(34rem,calc(100dvh-4rem))] flex-col gap-0 p-0 pt-4 pb-3 sm:max-w-[35rem]"
			>
				<ToolActivityLog
					activity={activity}
					looks={looks}
					at={at}
					headingId={headingId}
					className="min-h-0 flex-1"
				/>
			</DialogContent>
		</Dialog>
	);
}
