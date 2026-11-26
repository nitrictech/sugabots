import { Popover } from "@base-ui/react/popover";
import type { BotParticipant, ChatHistoryEntry, Run } from "@sugabots/contracts";
import { Braces, ExternalLink } from "lucide-react";
import { type ReactNode, type Ref, useEffect, useRef } from "react";
import { useAuthorLinks } from "@/lib/author-links.tsx";
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

/**
 * An automation's run as a page of its own, where its chat would be, as a
 * notification opens one: `back` before its name, as a phone's Back to the
 * list it covers, and `trailing` at its header's right, such as the way to
 * the chat itself.
 */
export function NestedChatPanel({
	chatId,
	owner,
	nestedChatId,
	entry,
	back,
	trailing,
}: {
	chatId: string;
	/** Whose the chat it opened from is, whose automation a run's settings are among. */
	owner?: ResourceOwner;
	nestedChatId: string;
	entry?: ChatHistoryEntry;
	back: BackTo;
	trailing: ReactNode;
}) {
	const query = useChat(nestedChatId);
	const authorLinkOf = useAuthorLinks();
	useChatEvents(nestedChatId);
	const notices = useChatNotices(nestedChatId);
	const heading = useRef<HTMLHeadingElement>(null);
	const timeline = useRef<HTMLDivElement>(null);
	const details = query.data;
	const isRun = (entry?.kind ?? details?.chat.kind) === "run";
	const automationRun = details?.automationRun;
	// An automation's run shows its result, not the trigger that started it.
	const shownMessages = (details?.messages ?? []).filter(
		(message) => message.author.kind !== "automation_trigger",
	);
	// A run records the bot that ran it; a run in a project members made is with no bot of its own.
	const hostBotId = automationRun?.botId ?? details?.chat.botId;
	const host = details?.participants.find(
		(participant): participant is BotParticipant =>
			participant.kind === "bot" && participant.id === hostBotId,
	);

	useEffect(() => {
		if (nestedChatId) heading.current?.focus();
	}, [nestedChatId]);

	const loadOlder = () => loadOlderKeepingPlace(timeline.current, query.loadOlder);

	const title = details?.chat.title ?? "Chat";
	const body = query.isPending ? (
		<div className="grid flex-1 place-content-center text-muted-foreground text-xs">
			Loading chat…
		</div>
	) : !details ||
		!host ||
		!isRun ||
		(details.chat.rootChatId !== chatId && entry?.chatId !== nestedChatId) ? (
		<EmptyState title="Could not load this chat">Go back and open it again.</EmptyState>
	) : (
		<div
			ref={timeline}
			role="log"
			aria-label="Run messages"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a chat longer than the page scrolls, so the keyboard has to reach it too.
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
			{automationRun?.state === "failed" && details.chat.projectId && (
				<FailedRunMessage run={automationRun} projectId={details.chat.projectId} bot={host} />
			)}
			<ChatMessages
				fileUrlOf={(fileId) => chatFileUrl(nestedChatId, fileId)}
				messages={shownMessages}
				answeringFace={findAnsweringFace(shownMessages, true)}
				typing={{
					host,
					// A notice says the reply is not coming, so nobody is shown typing it.
					isRunning: details.chat.working && notices.length === 0,
				}}
				participants={mentionableIn(details)}
				membersReachingProject={details.membersReachingProject}
				chatKind={details.chat.kind}
				projectId={details.chat.projectId}
				approvalPermissions={details.permissions}
				compact
				authorLinkOf={authorLinkOf}
			/>
			<ChatNotices notices={notices} />
		</div>
	);
	return (
		<NestedChatAsPage
			label={title}
			heading={isRun ? (automationRun?.automationName ?? title) : title}
			headingRef={heading}
			actions={
				isRun && automationRun && <AutomationHeaderActions run={automationRun} owner={owner} />
			}
			back={back}
			trailing={trailing}
		>
			{body}
		</NestedChatAsPage>
	);
}

/** A nested chat as a page of its own: a header naming it, and its chat under it. */
function NestedChatAsPage({
	label,
	heading,
	headingRef,
	actions,
	back,
	trailing,
	children,
}: {
	label: string;
	heading: string;
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
