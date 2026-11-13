import { Popover } from "@base-ui/react/popover";
import type { PersonParticipant, SessionUser } from "@sugabots/contracts";
import { User } from "lucide-react";
import type { DirectPeople } from "@/lib/chats.ts";
import { countOf } from "@/lib/name-list.ts";
import { FormerMemberFace } from "@/shell/DirectMessages.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";

/** The faces in the list of who is in a direct message. */
const FACE_SIZE_PX = 24;

/**
 * At the right of a group direct message's header: how many are in it, you
 * included, which drops down the list of them. Nobody can be added, as the
 * people in a direct message are what it is: writing to somebody else as well
 * starts a conversation of its own, from New message.
 */
export function DirectMembersButton({ direct, user }: { direct: DirectPeople; user: SessionUser }) {
	const everyone = direct.people.length + direct.formerMembers + 1;
	return (
		<Popover.Root>
			<Popover.Trigger
				aria-label={`${countOf(everyone, "member", "members")}. Show who is here`}
				className="focus-ring flex h-8 shrink-0 items-center gap-1.5 rounded-sm px-2 text-2xs text-muted-foreground tabular-nums transition-colors hover:bg-row-hover hover:text-foreground data-popup-open:bg-row-selected data-popup-open:text-foreground"
			>
				<User aria-hidden size={15} strokeWidth={1.75} />
				{everyone}
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner
					side="bottom"
					align="end"
					sideOffset={6}
					collisionPadding={16}
					className="isolate z-50 outline-none"
				>
					<Popover.Popup className="w-64 origin-(--transform-origin) rounded-lg border border-border-strong bg-panel p-3 text-foreground shadow-popover outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95">
						<Popover.Title className="m-0 font-semibold text-sm leading-snug">
							{countOf(everyone, "member", "members")}
						</Popover.Title>
						<ul aria-label="Members" className="m-0 mt-2.5 flex list-none flex-col gap-2 p-0">
							{direct.people.map((person) => (
								<MemberRow key={person.id} person={person} />
							))}
							<MemberRow person={user} you />
							{direct.formerMembers > 0 && (
								<li className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
									<FormerMemberFace size={FACE_SIZE_PX} />
									<span className="truncate">
										{countOf(direct.formerMembers, "former member", "former members")}
									</span>
								</li>
							)}
						</ul>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}

/** Somebody in a direct message: their face and name, and "You" for the viewer. */
function MemberRow({
	person,
	you = false,
}: {
	person: Pick<PersonParticipant, "name" | "email" | "image">;
	you?: boolean;
}) {
	return (
		<li className="flex min-w-0 items-center gap-2 text-sm">
			<span aria-hidden className="flex shrink-0">
				<PersonAvatar person={person} size={FACE_SIZE_PX} />
			</span>
			<span className="min-w-0 flex-1 truncate">{person.name}</span>
			{you && <span className="shrink-0 text-2xs text-muted-foreground">You</span>}
		</li>
	);
}
