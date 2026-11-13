import {
	type DirectMessageListItem,
	MAX_DIRECT_MESSAGE_PEOPLE,
	type PersonParticipant,
} from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { MessageCircle, X } from "lucide-react";
import {
	type KeyboardEvent,
	useDeferredValue,
	useEffect,
	useEffectEvent,
	useId,
	useRef,
	useState,
} from "react";
import { addToChatDraft, joinDrafts, splitDraft, takeChatDraft } from "@/lib/chat-draft.ts";
import { personParticipantOf, useDirectMessages, useSendDirectMessage } from "@/lib/chats.ts";
import { useComposerAttachments } from "@/lib/composer-attachments.ts";
import { failureMessage } from "@/lib/failure.ts";
import { directMessageLink } from "@/lib/links.ts";
import { listNames } from "@/lib/name-list.ts";
import { useSession } from "@/lib/session.ts";
import { useWorkspace, useWorkspaceMembers } from "@/lib/workspace.ts";
import { ChatComposer } from "@/screens/ChatComposer.tsx";
import { PeopleChatHeader } from "@/screens/ChatHeader.tsx";
import { ConversationPage } from "@/screens/ConversationPage.tsx";
import { DirectPeopleAvatar } from "@/shell/DirectMessages.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";

/** The most others a direct message holds: everyone in it but the sender. */
const MAX_OTHERS = MAX_DIRECT_MESSAGE_PEOPLE - 1;

/**
 * Starting a direct message, as a page: whom to, in a To field that holds
 * several people, then the first message. The field suggests everybody else
 * in the workspace, those the viewer has written to alone most recently first;
 * people only, as direct messages have no bots. Once somebody is chosen the
 * suggestions close until the viewer types again, and the page shows the
 * conversation the message will go to: the one they already have with those
 * people, to write in there and then, or a note that it starts one. What the
 * viewer has written goes with them as the people chosen change, from one
 * conversation's draft to another's. Sending to people with no conversation
 * yet has the API open one with the message, then opens it.
 */
export function NewDirectMessagePage() {
	const { user } = useSession();
	const { workspace } = useWorkspace();
	const members = useWorkspaceMembers(workspace?.id);
	const directMessages = useDirectMessages();
	const start = useSendDirectMessage();
	const navigate = useNavigate();
	// Nothing attaches before there is a conversation to upload to: the first
	// message is words alone, and files go in once it is open.
	const attachments = { ...useComposerAttachments(undefined), attach: undefined };
	const [chosen, setChosen] = useState<readonly PersonParticipant[]>([]);
	const [query, setQuery] = useState("");
	const needle = useDeferredValue(query.trim().toLowerCase());
	const [active, setActive] = useState(0);
	const [draft, setDraft] = useState("");
	const [browsing, setBrowsing] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const listId = useId();

	useEffect(() => input.current?.focus(), []);

	const chosenIds = new Set(chosen.map((person) => person.id));
	const full = chosen.length >= MAX_OTHERS;
	const recency = recentOneToOnes(directMessages.data?.items ?? []);
	const suggestions = full
		? []
		: (members.data ?? [])
				.map((member) => personParticipantOf(member.user))
				.filter((person) => person.id !== user?.id && !chosenIds.has(person.id))
				.filter((person) => matches(needle, person))
				.sort(
					(left, right) =>
						(recency.get(left.id) ?? Infinity) - (recency.get(right.id) ?? Infinity) ||
						left.name.localeCompare(right.name),
				);
	// Until somebody is chosen it offers everybody; after that, whoever the viewer types, or browses for with the arrow keys.
	const suggesting = browsing || query.trim() !== "" || chosen.length === 0;
	const shown = suggesting ? suggestions : [];
	const activeIndex = Math.min(active, shown.length - 1);
	const optionId = (index: number) => `${listId}-${index}`;
	// The conversation there already is with the people chosen, shown in place of a new one.
	const existing = existingWith(directMessages.data?.items ?? [], chosenIds);

	// What the viewer has written here goes with them to the conversation shown,
	// whether the people chosen changed or their conversations loaded after they
	// chose. `home` is where it is now: null for this page's own draft, or a
	// conversation's saved draft, added after what that held already
	// (`homeBefore`), which stays there when the viewer moves on. A conversation's
	// composer reads its draft only as it opens, so it shows once the draft is
	// there (`ready`).
	const shownId = existing?.conversation.id ?? null;
	const home = useRef<string | null>(null);
	const homeBefore = useRef("");
	const [ready, setReady] = useState<string | null>(null);
	const moveDraftTo = useEffectEvent((to: string | null, viewerId: string | undefined) => {
		if (!viewerId) return;
		const from = home.current;
		if (from !== to) {
			let written = draft;
			if (from) {
				const { kept, added } = splitDraft(homeBefore.current, takeChatDraft(viewerId, null, from));
				addToChatDraft(viewerId, null, from, kept);
				written = added;
			} else {
				setDraft("");
			}
			if (to) {
				homeBefore.current = takeChatDraft(viewerId, null, to);
				addToChatDraft(viewerId, null, to, joinDrafts(homeBefore.current, written));
			} else {
				setDraft((current) => joinDrafts(current, written));
			}
			home.current = to;
		}
		setReady(to);
	});
	// Again once the viewer is known, as nothing moves without them.
	const viewerId = user?.id;
	useEffect(() => moveDraftTo(shownId, viewerId), [shownId, viewerId]);

	/** Opens the conversation shown here on its own page, as writing in it, or opening anything from it, does. */
	function openConversation() {
		if (existing) void navigate({ ...directMessageLink(existing.conversation.id), replace: true });
	}

	/** Chooses `next`, clearing a failure to send to the people chosen before. */
	function changeChosen(next: readonly PersonParticipant[]) {
		setChosen(next);
		start.reset();
	}

	function choose(person: PersonParticipant) {
		changeChosen([...chosen, person].slice(0, MAX_OTHERS));
		setQuery("");
		setActive(0);
		setBrowsing(false);
		input.current?.focus();
	}

	function remove(personId: string) {
		changeChosen(chosen.filter((person) => person.id !== personId));
		input.current?.focus();
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (!suggesting) {
				setBrowsing(true);
				setActive(0);
				return;
			}
			if (shown.length === 0) return;
			const step = event.key === "ArrowDown" ? 1 : -1;
			setActive((activeIndex + step + shown.length) % shown.length);
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const person = shown[activeIndex];
			if (person) choose(person);
			return;
		}
		if (event.key === "Escape" && browsing) {
			event.preventDefault();
			setBrowsing(false);
			return;
		}
		if (event.key === "Backspace" && query === "" && chosen.length > 0) {
			event.preventDefault();
			changeChosen(chosen.slice(0, -1));
		}
	}

	async function submit() {
		const message = draft.trim();
		// Enter sends as Send does, which is off until somebody is chosen.
		if (start.isPending || message === "" || chosen.length === 0) return;
		const written = draft;
		// Cleared while it sends: the conversation it opens joins the list before
		// the send settles, and what is written here would go on to it as a draft.
		setDraft("");
		const sent = await start
			.mutateAsync({ userIds: chosen.map((person) => person.id), message })
			.catch(() => undefined);
		if (!sent) {
			setDraft((current) => joinDrafts(written, current));
			return;
		}
		// In New message's place, as opening a conversation from it is.
		await navigate({ ...directMessageLink(sent.conversation.id), replace: true });
	}

	const names = listNames(chosen.map((person) => person.name));
	const suggestionList = (
		<>
			{full && (
				<p className="m-0 px-2 py-2 text-xs text-muted-foreground">
					A direct message holds up to {MAX_DIRECT_MESSAGE_PEOPLE} people, you included.
				</p>
			)}
			<div
				id={listId}
				role="listbox"
				aria-label="Suggestions"
				className={cn("flex flex-col gap-px", shown.length === 0 && "hidden")}
			>
				{shown.map((person, index) => (
					<button
						key={person.id}
						id={optionId(index)}
						type="button"
						role="option"
						tabIndex={-1}
						aria-selected={index === activeIndex}
						// Keeps the focus, and so the caret, in the To field.
						onMouseDown={(event) => event.preventDefault()}
						onMouseEnter={() => setActive(index)}
						onClick={() => choose(person)}
						className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left aria-selected:bg-row-selected max-md:py-2"
					>
						<SuggestionRow person={person} />
					</button>
				))}
			</div>
			{/* When full, the note above says why there is nobody more. */}
			{suggesting && shown.length === 0 && members.isSuccess && !full && (
				<p className="m-0 px-2 py-6 text-center text-xs text-muted-foreground">
					{query.trim() !== ""
						? `Nobody matches “${query.trim()}”`
						: chosen.length > 0
							? "Everybody else here is chosen."
							: "Nobody else is here yet. Invite people from Settings."}
				</p>
			)}
		</>
	);
	return (
		<div className="flex min-w-0 flex-1 flex-col">
			<PeopleChatHeader
				title="New message"
				back={{ to: "directMessages" }}
				face={
					<span className="grid size-8 shrink-0 place-items-center rounded-full bg-chip text-soft-foreground">
						<MessageCircle size={16} strokeWidth={2} />
					</span>
				}
			/>
			<div className="flex flex-wrap items-center gap-1.5 border-border border-b px-5 py-2 max-md:px-4">
				<label htmlFor={`${listId}-input`} className="pr-1 text-sm text-muted-foreground">
					To:
				</label>
				{chosen.length > 0 && (
					<ul aria-label="Recipients" className="m-0 contents list-none p-0">
						{chosen.map((person) => (
							<li
								key={person.id}
								className="flex h-7 items-center gap-1.5 rounded-sm bg-chip pr-1 pl-1 text-sm text-foreground"
							>
								<span aria-hidden className="flex">
									<PersonAvatar person={person} size={20} />
								</span>
								{person.name}
								<button
									type="button"
									aria-label={`Remove ${person.name}`}
									onClick={() => remove(person.id)}
									className="focus-ring grid size-5 place-items-center rounded-xs text-muted-foreground hover:bg-hover hover:text-foreground"
								>
									<X size={12} strokeWidth={2.4} />
								</button>
							</li>
						))}
					</ul>
				)}
				<input
					ref={input}
					id={`${listId}-input`}
					type="text"
					role="combobox"
					aria-autocomplete="list"
					aria-expanded={shown.length > 0}
					aria-controls={listId}
					aria-activedescendant={shown.length > 0 ? optionId(activeIndex) : undefined}
					autoComplete="off"
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						setActive(0);
					}}
					onKeyDown={onKeyDown}
					onBlur={() => setBrowsing(false)}
					placeholder={chosen.length === 0 ? "Somebody's name or email" : ""}
					className="h-8 min-w-30 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
				/>
			</div>
			{existing && user ? (
				// Kept while suggestions cover it, so what is written and attached there stays.
				<div className="relative flex min-h-0 flex-1 flex-col">
					{ready === existing.conversation.id && (
						<ConversationPage
							conversation={{
								kind: "direct",
								people: existing.people,
								formerMembers: existing.formerMembers,
							}}
							pod={null}
							conversationId={existing.conversation.id}
							user={user}
							onThreadChange={openConversation}
							onStagedChange={openConversation}
							headerless
							onSent={openConversation}
							covered={suggesting}
						/>
					)}
					{suggesting && (
						<div className="absolute inset-0 z-20 overflow-y-auto bg-background px-3 py-2 max-md:px-2">
							{suggestionList}
						</div>
					)}
				</div>
			) : (
				<>
					<div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 max-md:px-2">
						{suggestionList}
						{/* Once the viewer's conversations are known, so it never says one starts that is there. */}
						{!suggesting && directMessages.isSuccess && (
							<NewConversationNote people={chosen} names={names} />
						)}
					</div>
					<div className="shrink-0 px-4 max-md:pb-tab-bar md:px-5">
						<ChatComposer
							label={chosen.length > 0 ? `Message ${names}` : "Start a new message"}
							value={draft}
							onValueChange={setDraft}
							onSubmit={submit}
							submitLabel="Send message"
							sending={start.isPending}
							needsText
							hasRecipients={chosen.length > 0}
							error={
								start.isError
									? `Message not sent. ${failureMessage(start.error)}. Your draft is still here.`
									: undefined
							}
							className="w-full"
							mentionable={[...chosen]}
							attachments={attachments}
						/>
						<div className="h-6.5 max-md:h-2" />
					</div>
				</>
			)}
		</div>
	);
}

/** A person as the To field suggests them: their face, name and email. */
function SuggestionRow({ person }: { person: PersonParticipant }) {
	return (
		<>
			<span aria-hidden className="flex shrink-0">
				<PersonAvatar person={person} size={28} />
			</span>
			<span className="flex min-w-0 flex-1 items-baseline gap-2">
				<span className="truncate text-sm text-foreground">{person.name}</span>
				<span className="truncate text-2xs text-subtle-foreground">{person.email}</span>
			</span>
		</>
	);
}

/** Who a message to people the viewer has no conversation with yet goes to, and that it starts one. */
function NewConversationNote({
	people,
	names,
}: {
	people: readonly PersonParticipant[];
	names: string;
}) {
	return (
		<div className="flex flex-col items-start gap-2 px-2 pt-4">
			<DirectPeopleAvatar people={people} formerMembers={0} size={48} />
			<p className="m-0 font-semibold text-base text-foreground text-balance">{names}</p>
			<p className="m-0 max-w-130 text-sm text-muted-foreground leading-normal">
				{people.length === 1
					? "Your message starts a direct message that only the two of you can see."
					: "Your message starts a conversation that only the people in it can see."}
			</p>
		</div>
	);
}

/** Whether `person` has `needle`, already lower-cased, in their name or email; an empty needle matches everybody. */
function matches(needle: string, person: { name: string; email: string }): boolean {
	return (
		needle === "" ||
		person.name.toLowerCase().includes(needle) ||
		person.email.toLowerCase().includes(needle)
	);
}

/**
 * The people the viewer has a direct message with alone, by their id, to how
 * recent it is: 0 for the most recent, as the list comes newest first.
 */
function recentOneToOnes(items: readonly DirectMessageListItem[]): ReadonlyMap<string, number> {
	const ranks = new Map<string, number>();
	for (const item of items) {
		const [person] = item.people;
		if (item.people.length === 1 && item.formerMembers === 0 && person && !ranks.has(person.id)) {
			ranks.set(person.id, ranks.size);
		}
	}
	return ranks;
}

/** The viewer's direct message with exactly `peopleIds`, when they have one. */
function existingWith(
	items: readonly DirectMessageListItem[],
	peopleIds: ReadonlySet<string>,
): DirectMessageListItem | undefined {
	if (peopleIds.size === 0) return undefined;
	return items.find(
		(item) =>
			item.formerMembers === 0 &&
			item.people.length === peopleIds.size &&
			item.people.every((person) => peopleIds.has(person.id)),
	);
}
