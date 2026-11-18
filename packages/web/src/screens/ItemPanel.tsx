import type { ChatHistoryEntry, Participant, Run } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { Braces, ChevronLeft, ExternalLink } from "lucide-react";
import { type ReactNode, type Ref, useEffect, useRef } from "react";
import { useAuthorLinks } from "@/lib/author-links.ts";
import { useBot } from "@/lib/bots.ts";
import { chatFileUrl } from "@/lib/chat-files.ts";
import { useConversationEvents, useConversationNotices } from "@/lib/conversation-events.ts";
import { useConversation } from "@/lib/conversations.ts";
import { automationFeedLink } from "@/lib/links.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { Button } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsIcon } from "@/ui/settings-icon.tsx";
import { FailedRunMessage } from "./AutomationRun.tsx";
import type { ItemConversationKind } from "./ChatActivityRow.tsx";
import { type BackTo, HeaderBack } from "./ChatHeader.tsx";
import { ChatSidebar } from "./ChatSidebar.tsx";
import { ConversationMessages } from "./ConversationMessages.tsx";
import { ConversationNotices } from "./ConversationNotices.tsx";
import { findAnsweringFace } from "./conversation-layout.ts";
import { mentionableIn } from "./mentions.tsx";

type BotParticipant = Extract<Participant, { kind: "bot" }>;

/**
 * Where an item's panel is shown: as the sidebar beside the chat, which closes,
 * or as a page of its own where the chat would be, as Inbox opens one, with
 * a phone's Back to the list it covers and something at its header's right,
 * such as the way to the chat itself.
 */
export type ItemFrame =
	| { kind: "sidebar"; onClose: () => void }
	| { kind: "page"; back: BackTo; trailing: ReactNode };

/** A collaboration or automation run opened from its line, framed by `frame`. */
export function ItemPanel({
	conversationId,
	chatBotId,
	itemConversationId,
	entry,
	history,
	frame,
	onOpenItem,
	onOpenFile,
}: {
	conversationId: string;
	/**
	 * The bot whose task this opened from, which a collaboration draws on the
	 * right; undefined in a channel, where it is drawn from the bot it is with.
	 */
	chatBotId: string | undefined;
	itemConversationId: string;
	entry?: ChatHistoryEntry;
	history: ChatHistoryEntry[];
	frame: ItemFrame;
	onOpenItem: (itemConversationId: string) => void;
	onOpenFile?: (fileId: string) => void;
}) {
	const query = useConversation(itemConversationId);
	const authorLinkOf = useAuthorLinks();
	useConversationEvents(itemConversationId);
	const notices = useConversationNotices(itemConversationId);
	const heading = useRef<HTMLHeadingElement>(null);
	const timeline = useRef<HTMLDivElement>(null);
	const details = query.data;
	const type = openableItemKind(entry?.kind ?? details?.conversation.kind, frame);
	const automationRun = details?.automationRun;
	// An automation's run shows its result, not the trigger that started it.
	const shownMessages =
		type === "run"
			? (details?.messages ?? []).filter((message) => message.author.kind !== "automation_trigger")
			: (details?.messages ?? []);
	// Beside a chat a run never opens, so neither is there a way back to one.
	const parentAutomation =
		frame.kind === "sidebar"
			? undefined
			: history.find(
					(item) =>
						item.conversationId === details?.conversation.parentConversationId &&
						item.kind === "run",
				);
	const host = details?.participants.find(
		(participant): participant is BotParticipant =>
			participant.kind === "bot" && participant.id === details.conversation.botId,
	);
	// A collaboration is seen from the chat's bot: it first, on the right, and the other bot beside it.
	const mine =
		details?.participants.find(
			(participant): participant is BotParticipant =>
				participant.kind === "bot" && participant.id === chatBotId,
		) ?? host;
	const other = details?.participants.find(
		(participant): participant is BotParticipant =>
			participant.kind === "bot" && participant.id !== mine?.id,
	);
	// Opened from the chat of the bot that was asked, whose conversation it is not in.
	const askedOfChatBot =
		details?.conversation.kind === "collaboration" && details.conversation.botId === chatBotId;

	useEffect(() => {
		if (itemConversationId) heading.current?.focus();
	}, [itemConversationId]);

	async function loadOlder() {
		const element = timeline.current;
		const height = element?.scrollHeight ?? 0;
		const top = element?.scrollTop ?? 0;
		await query.loadOlder();
		requestAnimationFrame(() => {
			if (element) element.scrollTop = top + element.scrollHeight - height;
		});
	}

	const title = details?.conversation.title ?? "Conversation";
	const headed = {
		label: title,
		heading:
			type === "collaboration"
				? "Collaboration"
				: type === "run"
					? (automationRun?.automationName ?? title)
					: title,
		subheading: type === "collaboration" ? other && `${mine?.name} and ${other.name}` : undefined,
		headingRef: heading,
		actions: type === "run" && automationRun && (
			<AutomationHeaderActions execution={automationRun} />
		),
	};
	const body = query.isPending ? (
		<div className="grid flex-1 place-content-center text-muted-foreground text-xs">
			Loading conversation…
		</div>
	) : !details ||
		!host ||
		!type ||
		(details.conversation.rootConversationId !== conversationId &&
			entry?.conversationId !== itemConversationId &&
			!askedOfChatBot) ? (
		<EmptyState title="Could not load this conversation">
			{frame.kind === "sidebar"
				? "Try closing this panel and opening it again."
				: "Go back and open it again."}
		</EmptyState>
	) : (
		<>
			{parentAutomation && (
				<button
					type="button"
					onClick={() => onOpenItem(parentAutomation.conversationId)}
					className="focus-ring mx-4.5 mt-3 inline-flex items-center gap-1 self-start rounded-md font-medium text-link text-xs"
				>
					<ChevronLeft aria-hidden size={14} />
					Back to automation
				</button>
			)}
			<div
				ref={timeline}
				role="log"
				aria-label="Conversation messages"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a conversation longer than the sheet scrolls, so the keyboard has to reach it too.
				tabIndex={0}
				className="focus-ring min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-2 pb-2"
			>
				{query.loadOlderError && (
					<p role="alert" className="m-0 px-4.5 pb-3 text-destructive-text text-xs">
						Earlier messages could not be loaded.
					</p>
				)}
				{details.olderMessagesCursor && (
					<Button
						variant="link"
						size="bare"
						className="mx-auto mb-3 flex"
						disabled={query.isLoadingOlder}
						onClick={() => void loadOlder().catch(() => {})}
					>
						{query.isLoadingOlder ? "Loading…" : "Load older messages"}
					</Button>
				)}
				{type === "run" && automationRun?.state === "failed" && (
					<FailedRunMessage execution={automationRun} bot={host} />
				)}
				<ConversationMessages
					fileUrlOf={(fileId) => chatFileUrl(conversationId, fileId)}
					messages={shownMessages}
					answeringFace={findAnsweringFace(shownMessages, true)}
					host={host}
					// A notice says the reply is not coming, so nobody is shown typing it.
					isRunning={details.conversation.status === "running" && notices.length === 0}
					participants={mentionableIn(details)}
					members={details.members}
					conversationKind={details.conversation.kind}
					onOpenItem={onOpenItem}
					onOpenFile={onOpenFile}
					approvalCapabilities={details.capabilities}
					compact
					authorLinkOf={authorLinkOf}
				/>
				<ConversationNotices notices={notices} />
			</div>
			{frame.kind === "sidebar" && type === "collaboration" && mine && (
				<p className="m-0 shrink-0 border-border border-t px-4.5 py-3 text-xs text-subtle-foreground leading-normal">
					Bots talk here on their own.
					{/* A message to the asked bot in its own chat starts other work, which never reaches this. */}
					{!askedOfChatBot && ` To weigh in, message ${mine.name} in the main chat.`}
				</p>
			)}
		</>
	);
	if (frame.kind === "page") {
		return (
			<ItemPage {...headed} back={frame.back} trailing={frame.trailing}>
				{body}
			</ItemPage>
		);
	}
	return (
		<ChatSidebar
			{...headed}
			onClose={frame.onClose}
			sheet
			// Wider than Details: it holds a whole conversation.
			className="w-140 md:max-xl:w-150 max-w-full"
		>
			{body}
		</ChatSidebar>
	);
}

/** An item as a page of its own: a header naming it, and its conversation under it. */
function ItemPage({
	label,
	heading,
	subheading,
	headingRef,
	actions,
	back,
	trailing,
	children,
}: {
	label: string;
	heading: string;
	subheading?: string;
	headingRef: Ref<HTMLHeadingElement>;
	actions?: ReactNode;
	back: BackTo;
	trailing: ReactNode;
	children: ReactNode;
}) {
	return (
		<section aria-label={label} className="flex min-h-0 min-w-0 flex-1 flex-col">
			<header className="relative flex h-13 shrink-0 items-center gap-2 border-border border-b pr-4 pl-6 max-md:gap-3 max-md:pl-4">
				<HeaderBack back={back} />
				<div className="flex min-w-0 flex-1 items-baseline gap-2">
					<h1
						ref={headingRef}
						tabIndex={-1}
						className="m-0 min-w-0 shrink-0 truncate font-medium text-sm text-foreground outline-none max-md:shrink"
					>
						{heading}
					</h1>
					{subheading && (
						<span className="min-w-0 truncate text-xs text-subtle-foreground">{subheading}</span>
					)}
				</div>
				{actions}
				{trailing}
			</header>
			{children}
		</section>
	);
}

function AutomationHeaderActions({ execution }: { execution: Run }) {
	const backToChat = useBackToHere("Chat");
	const bot = useBot(execution.botId);
	return (
		<>
			{execution.trigger.kind === "webhook" && (
				<details className="group relative">
					<IconButton
						label="View webhook payload"
						variant="bar"
						render={<summary />}
						className="list-none [&::-webkit-details-marker]:hidden"
					>
						<Braces aria-hidden size={15} strokeWidth={2.4} />
					</IconButton>
					{/* Hangs from the sidebar's top right corner, so it opens leftwards. */}
					<div className="absolute right-0 z-20 mt-2 w-header-popover overflow-hidden rounded-panel bg-panel text-left shadow-dialog">
						{execution.trigger.idempotencyKey && (
							<div className="flex items-baseline gap-2 border-border border-b px-4 py-2.5 text-xs">
								<span className="text-muted-foreground">Idempotency key</span>
								<code className="truncate font-mono text-foreground">
									{execution.trigger.idempotencyKey}
								</code>
							</div>
						)}
						<pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs text-soft-foreground leading-relaxed">
							{JSON.stringify(execution.trigger.payload, null, 2)}
						</pre>
					</div>
				</details>
			)}
			{execution.trigger.kind === "github" && (
				<IconButton
					label="Open what started it"
					variant="bar"
					render={<a href={execution.trigger.url} target="_blank" rel="noreferrer" />}
				>
					<ExternalLink aria-hidden size={15} strokeWidth={2.4} />
				</IconButton>
			)}
			{bot && (
				<IconButton
					label="Automation settings"
					variant="bar"
					render={<Link {...automationFeedLink(bot, execution.automationId)} state={backToChat} />}
				>
					<SettingsIcon />
				</IconButton>
			)}
		</>
	);
}

/** The kind of conversation `type` is, when it may open in `frame`: a run only as a page of its own, never beside a chat. */
function openableItemKind(
	type: string | undefined,
	frame: ItemFrame,
): ItemConversationKind | undefined {
	if (type === "collaboration") return type;
	return type === "run" && frame.kind !== "sidebar" ? type : undefined;
}
