import { Popover } from "@base-ui/react/popover";
import type { BotParticipant, ChatHistoryEntry, Run } from "@sugabots/contracts";
import { Braces, ChevronLeft, ExternalLink } from "lucide-react";
import { type ReactNode, type Ref, useEffect, useRef } from "react";
import { useAuthorLinks } from "@/lib/author-links.ts";
import { useChatEvents, useChatNotices } from "@/lib/chat-events.ts";
import { chatFileUrl } from "@/lib/chat-files.ts";
import { useChat } from "@/lib/chat-query.ts";
import { loadOlderKeepingPlace } from "@/lib/follow-latest.ts";
import { OwnerLink, type ResourceOwner } from "@/lib/resource-owner.tsx";
import { Button } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { PopoverContent } from "@/ui/popover.tsx";
import { SettingsIcon } from "@/ui/settings-icon.tsx";
import { FailedRunMessage } from "./AutomationRun.tsx";
import { type BackTo, HeaderBack } from "./ChatHeader.tsx";
import { ChatMessages } from "./ChatMessages.tsx";
import { ChatNotices } from "./ChatNotices.tsx";
import { findAnsweringFace } from "./chat-layout.ts";
import { mentionableIn } from "./mentions.tsx";
import { SidePanel } from "./SidePanel.tsx";

/** The kinds of chat that open from a line in a chat: a collaboration, or an automation's run. */
type NestedChatKind = ChatHistoryEntry["kind"];

/**
 * Where a nested chat's panel is shown: as the side panel beside the chat, which closes,
 * or as a page of its own where the chat would be, as a notification opens one, with
 * a phone's Back to the list it covers and something at its header's right,
 * such as the way to the chat itself.
 */
type NestedChatFrame =
	| { kind: "beside"; onClose: () => void }
	| { kind: "page"; back: BackTo; trailing: ReactNode };

/** A collaboration or automation run opened from its line, framed by `frame`. */
export function NestedChatPanel({
	chatId,
	chatBotId,
	owner,
	nestedChatId,
	entry,
	history,
	frame,
	onOpenNestedChat,
	onOpenFile,
}: {
	chatId: string;
	/**
	 * The bot whose chat this opened from, which a collaboration draws on the
	 * right; undefined in a project, where it is drawn from the bot it is with.
	 */
	chatBotId: string | undefined;
	/** Whose the chat it opened from is, whose automation a run's settings are among. */
	owner?: ResourceOwner;
	nestedChatId: string;
	entry?: ChatHistoryEntry;
	history: ChatHistoryEntry[];
	frame: NestedChatFrame;
	onOpenNestedChat: (nestedChatId: string) => void;
	onOpenFile?: (fileId: string) => void;
}) {
	const query = useChat(nestedChatId);
	const authorLinkOf = useAuthorLinks("Chat");
	useChatEvents(nestedChatId);
	const notices = useChatNotices(nestedChatId);
	const heading = useRef<HTMLHeadingElement>(null);
	const timeline = useRef<HTMLDivElement>(null);
	const details = query.data;
	const type = openableNestedChatKind(entry?.kind ?? details?.chat.kind, frame);
	const automationRun = details?.automationRun;
	// An automation's run shows its result, not the trigger that started it.
	const shownMessages =
		type === "run"
			? (details?.messages ?? []).filter((message) => message.author.kind !== "automation_trigger")
			: (details?.messages ?? []);
	// Beside a chat a run never opens, so neither is there a way back to one.
	const parentAutomation =
		frame.kind === "beside"
			? undefined
			: history.find((item) => item.chatId === details?.chat.parentChatId && item.kind === "run");
	// A run records the bot that ran it; a run in a project people made is with no bot of its own.
	const hostBotId = automationRun?.botId ?? details?.chat.botId;
	const host = details?.participants.find(
		(participant): participant is BotParticipant =>
			participant.kind === "bot" && participant.id === hostBotId,
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
	// Opened from a chat of the bot that was asked, which the collaboration is not in.
	const askedOfChatBot = details?.chat.kind === "collaboration" && details.chat.botId === chatBotId;

	useEffect(() => {
		if (nestedChatId) heading.current?.focus();
	}, [nestedChatId]);

	const loadOlder = () => loadOlderKeepingPlace(timeline.current, query.loadOlder);

	const title = details?.chat.title ?? "Chat";
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
			<AutomationHeaderActions run={automationRun} owner={owner} />
		),
	};
	const body = query.isPending ? (
		<div className="grid flex-1 place-content-center text-muted-foreground text-xs">
			Loading chat…
		</div>
	) : !details ||
		!host ||
		!type ||
		(details.chat.rootChatId !== chatId && entry?.chatId !== nestedChatId && !askedOfChatBot) ? (
		<EmptyState title="Could not load this chat">
			{frame.kind === "beside"
				? "Try closing this panel and opening it again."
				: "Go back and open it again."}
		</EmptyState>
	) : (
		<>
			{parentAutomation && (
				<Button
					variant="link"
					size="text"
					className="mx-4.5 mt-3 gap-1 self-start"
					onClick={() => onOpenNestedChat(parentAutomation.chatId)}
				>
					<ChevronLeft aria-hidden size={14} />
					Back to automation
				</Button>
			)}
			<div
				ref={timeline}
				role="log"
				aria-label={type === "run" ? "Run messages" : "Collaboration messages"}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a chat longer than the sheet scrolls, so the keyboard has to reach it too.
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
				{type === "run" && automationRun?.state === "failed" && details.chat.projectId && (
					<FailedRunMessage run={automationRun} projectId={details.chat.projectId} bot={host} />
				)}
				<ChatMessages
					fileUrlOf={(fileId) => chatFileUrl(nestedChatId, fileId)}
					messages={shownMessages}
					answeringFace={findAnsweringFace(shownMessages, true)}
					typing={{
						host,
						// A notice says the reply is not coming, so nobody is shown typing it.
						isRunning: details.chat.status === "running" && notices.length === 0,
					}}
					participants={mentionableIn(details)}
					peopleReachingProject={details.peopleReachingProject}
					chatKind={details.chat.kind}
					projectId={details.chat.projectId}
					onOpenNestedChat={onOpenNestedChat}
					onOpenFile={onOpenFile}
					approvalCapabilities={details.capabilities}
					compact
					authorLinkOf={authorLinkOf}
				/>
				<ChatNotices notices={notices} />
			</div>
			{frame.kind === "beside" && type === "collaboration" && mine && (
				<p className="m-0 shrink-0 border-border border-t px-4.5 py-3 text-xs text-subtle-foreground leading-normal">
					Bots talk here on their own.
					{/* A message to the asked bot in its own chat starts other work, which never reaches this. */}
					{!askedOfChatBot && ` To weigh in, message ${mine.name} in the chat it came from.`}
				</p>
			)}
		</>
	);
	if (frame.kind === "page") {
		return (
			<NestedChatAsPage {...headed} back={frame.back} trailing={frame.trailing}>
				{body}
			</NestedChatAsPage>
		);
	}
	return (
		<SidePanel
			{...headed}
			onClose={frame.onClose}
			sheet
			// Wider than Details: it holds a whole chat.
			className="w-140 md:max-xl:w-150 max-w-full"
		>
			{body}
		</SidePanel>
	);
}

/** A nested chat as a page of its own: a header naming it, and its chat under it. */
function NestedChatAsPage({
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

/**
 * At the right of a run's page: what its webhook was sent, or the GitHub
 * event that started it, and the way to its automation's settings.
 */
function AutomationHeaderActions({ run, owner }: { run: Run; owner: ResourceOwner | undefined }) {
	return (
		<>
			{run.trigger.kind === "webhook" && (
				<Popover.Root>
					<Popover.Trigger
						render={
							<IconButton label="View webhook payload" variant="bar">
								<Braces aria-hidden size={15} strokeWidth={2.4} />
							</IconButton>
						}
					/>
					<PopoverContent
						aria-label="Webhook payload"
						align="end"
						className="w-header-popover overflow-hidden text-left"
					>
						{run.trigger.idempotencyKey && (
							<div className="flex items-baseline gap-2 border-border border-b px-4 py-2.5 text-xs">
								<span className="text-muted-foreground">Idempotency key</span>
								<code className="truncate font-mono text-foreground">
									{run.trigger.idempotencyKey}
								</code>
							</div>
						)}
						<pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs text-soft-foreground leading-relaxed">
							{JSON.stringify(run.trigger.payload, null, 2)}
						</pre>
					</PopoverContent>
				</Popover.Root>
			)}
			{run.trigger.kind === "github" && (
				<IconButton
					label="Open what started it"
					variant="bar"
					render={<a href={run.trigger.url} target="_blank" rel="noreferrer" />}
				>
					<ExternalLink aria-hidden size={15} strokeWidth={2.4} />
				</IconButton>
			)}
			{owner && (
				<IconButton
					label="Automation settings"
					variant="bar"
					render={
						<OwnerLink owner={owner} to={{ page: "automation", automationId: run.automationId }} />
					}
				>
					<SettingsIcon />
				</IconButton>
			)}
		</>
	);
}

/** The kind of chat `type` is, when it may open in `frame`: a run only as a page of its own, never beside a chat. */
function openableNestedChatKind(
	type: string | undefined,
	frame: NestedChatFrame,
): NestedChatKind | undefined {
	if (type === "collaboration") return type;
	return type === "run" && frame.kind !== "beside" ? type : undefined;
}
