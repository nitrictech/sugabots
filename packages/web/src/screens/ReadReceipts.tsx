import { cn } from "cn";
import { formatListTime } from "@/lib/list-time.ts";
import type { Receipt } from "@/lib/read-receipts.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

const FACE_SIZE = 16;

/**
 * The faces of everyone who has read as far as a message, at the right edge
 * under it. Hovering a face names who it is and when they read it.
 */
export function ReadReceipts({
	receipts,
	className,
}: {
	receipts: readonly Receipt[];
	/** Where a row too wide to fit wraps from. */
	className?: string;
}) {
	if (receipts.length === 0) return null;
	const names = new Intl.ListFormat("en", { type: "conjunction" }).format(
		receipts.map(({ reader }) => reader.name),
	);
	return (
		<div className={cn("flex flex-wrap justify-end gap-1 pt-1", className)}>
			<span className="sr-only">Read by {names}</span>
			{receipts.map((receipt) => (
				<ReceiptFace key={receipt.reader.id} receipt={receipt} />
			))}
		</div>
	);
}

/** A face fades in under the message its reader has reached. */
function ReceiptFace({ receipt: { reader, readAt } }: { receipt: Receipt }) {
	return (
		<Tooltip label={`${reader.name} · ${formatListTime(new Date(readAt), new Date())}`} side="top">
			<span
				aria-hidden
				className="flex transition-opacity duration-200 ease-out starting:opacity-0 motion-reduce:transition-none"
			>
				{reader.kind === "agent" ? (
					<AgentAvatar color={reader.color} face={reader.face} size={FACE_SIZE} />
				) : (
					<PersonAvatar name={reader.name} image={reader.image} size={FACE_SIZE} />
				)}
			</span>
		</Tooltip>
	);
}
