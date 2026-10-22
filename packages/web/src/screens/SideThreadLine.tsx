import type { ThreadParticipant } from "@sugabots/contracts";
import { cn } from "cn";
import { formatClockTime } from "@/lib/list-time.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";

/**
 * A thread opened from a message, as a line under it: the faces of who is in
 * it, what it is, when it last moved, and a tag for where it stands, or dots
 * while a bot is still at it. A bot's collaboration and a thread started from
 * a pod's chat both draw this, so they read alike. The whole line opens it.
 */
export function SideThreadLine({
	faces,
	label,
	description,
	lastActivityAt,
	tag,
	onOpen,
}: {
	faces: readonly ThreadParticipant[];
	label: string;
	/**
	 * What opening it opens, for assistive technology, which hears where it
	 * stands and when it last moved after it, as they are shown.
	 */
	description: string;
	lastActivityAt?: string;
	/** Where it stands, such as "Done", or dots in its place while it works. */
	tag: { text: string; urgent?: boolean } | "working" | undefined;
	onOpen: () => void;
}) {
	const lastReply = lastActivityAt && `Last reply ${formatClockTime(new Date(lastActivityAt))}`;
	const standing = tag === "working" ? "Working" : tag?.text;
	return (
		<button
			type="button"
			onClick={onOpen}
			aria-label={[description, standing, lastReply].filter(Boolean).join(", ")}
			className="focus-ring -ml-1.5 mt-[5px] flex max-w-full items-center gap-2 rounded-[8px] border border-transparent py-1 pr-2.5 pl-1.5 transition-colors hover:border-border-strong hover:bg-panel"
		>
			<span aria-hidden className="flex shrink-0">
				{faces.map((face) =>
					face.kind === "agent" ? (
						<AgentAvatar
							key={face.id}
							color={face.color}
							face={face.face}
							shape={face.shape}
							size={20}
							ringed={{ color: "var(--background)", width: 2 }}
							// Positioned, as a person's face is, so each face sits over the one before it.
							className="relative -mr-[7px]"
						/>
					) : face.kind === "person" ? (
						<PersonAvatar
							key={face.id}
							person={face}
							size={20}
							className="-mr-[7px] shadow-[0_0_0_2px_var(--background)]"
						/>
					) : null,
				)}
			</span>
			<span className="truncate pl-2 font-semibold text-[13px] text-link">{label}</span>
			{lastReply && (
				<span className="shrink-0 text-[12.5px] text-subtle-foreground">{lastReply}</span>
			)}
			{tag === "working" ? (
				<span aria-hidden className="typing-dots typing-dots-small shrink-0 text-muted-foreground">
					<i />
					<i />
					<i />
				</span>
			) : (
				tag && (
					<span
						className={cn(
							"shrink-0 rounded-[5px] px-1.5 py-px font-semibold text-[11.5px]",
							tag.urgent ? "bg-primary text-primary-foreground" : "bg-chip text-muted-foreground",
						)}
					>
						{tag.text}
					</span>
				)
			)}
		</button>
	);
}
