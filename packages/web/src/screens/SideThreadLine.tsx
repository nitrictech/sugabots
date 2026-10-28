import type { ThreadParticipant } from "@sugabots/contracts";
import { Check } from "lucide-react";
import { formatClockTime } from "@/lib/list-time.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";

/** Where a thread stands, at the end of its line: settled, waiting on somebody, or dots while a bot works. */
export type SideThreadStatus = "working" | { text: string; done?: boolean; urgent?: boolean };

/**
 * A thread opened from a message, hanging off it: a curve down from the
 * message, the faces of who is in it, what it is in bold, a quieter word
 * about it, where it stands, and when it last moved. A bot's collaboration and a
 * thread started from a pod's chat both draw this, so they read alike. The
 * whole line opens it.
 */
export function SideThreadLine({
	faces,
	label,
	detail,
	description,
	lastActivityAt,
	status,
	onOpen,
}: {
	faces: readonly ThreadParticipant[];
	label: string;
	/** After the label, quieter, such as the thread's name. */
	detail?: string;
	/**
	 * What opening it opens, for assistive technology, which hears where it
	 * stands and when it last moved after it, as they are shown.
	 */
	description: string;
	lastActivityAt?: string;
	status?: SideThreadStatus;
	onOpen: () => void;
}) {
	const time = lastActivityAt && formatClockTime(new Date(lastActivityAt));
	const standing = status === "working" ? "Working" : status?.text;
	return (
		<button
			type="button"
			onClick={onOpen}
			aria-label={[description, standing, time && `Last reply ${time}`].filter(Boolean).join(", ")}
			className="focus-ring group/thread mt-1 ml-2 flex max-w-full items-center gap-2 rounded-md pr-1.5 text-left"
		>
			<span
				aria-hidden
				className="-mt-1 h-4 w-2.5 shrink-0 self-start rounded-bl-[7px] border-border-dashed border-b border-l"
			/>
			<span aria-hidden className="flex shrink-0 py-1 pr-0.5">
				{faces.map((face) =>
					face.kind === "agent" ? (
						<AgentAvatar
							key={face.id}
							color={face.color}
							face={face.face}
							shape={face.shape}
							size={16}
							ringed={{ color: "var(--background)", width: 1.5 }}
							// Positioned, as a person's face is, so each face sits over the one before it.
							className="relative -mr-0.5"
						/>
					) : face.kind === "person" ? (
						<PersonAvatar
							key={face.id}
							person={face}
							size={16}
							className="-mr-0.5 shadow-[0_0_0_1.5px_var(--background)]"
						/>
					) : null,
				)}
			</span>
			<span className="truncate font-semibold text-[13px] text-foreground group-hover/thread:underline group-hover/thread:underline-offset-2">
				{label}
			</span>
			{detail && <span className="truncate text-[12.5px] text-subtle-foreground">{detail}</span>}
			{status === "working" ? (
				<span aria-hidden className="typing-dots typing-dots-small shrink-0 text-muted-foreground">
					<i />
					<i />
					<i />
				</span>
			) : status?.urgent ? (
				<span className="shrink-0 rounded-[5px] bg-primary px-1.5 py-px font-semibold text-[11.5px] text-primary-foreground">
					{status.text}
				</span>
			) : (
				status && (
					<span className="flex shrink-0 items-center gap-1 text-[12.5px] text-muted-foreground">
						{status.done && <Check aria-hidden size={12} strokeWidth={2.25} />}
						{status.text}
					</span>
				)
			)}
			{time && <span className="shrink-0 text-[12.5px] text-subtle-foreground">{time}</span>}
		</button>
	);
}
