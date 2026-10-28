import type { AgentParticipant, Pod } from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useAgents, useModelName } from "@/lib/agents.ts";
import { THREAD_NOT_STARTED, useOpenPodChat, useThreadStarter } from "@/lib/chats.ts";
import { useComposerAttachments } from "@/lib/composer-attachments.ts";
import { conversationLink } from "@/lib/links.ts";
import { useThread } from "@/lib/threads.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { ChatComposer } from "./ChatComposer.tsx";
import { PeopleChatHeader } from "./ChatHeader.tsx";
import { firstBotNamed, mentionableIn } from "./mentions.tsx";

/**
 * Starting a thread in a pod from its first message. Opened from a bot, it
 * asks what the bot should work on, in the middle of the page, and the thread
 * is with that bot whatever the message says. Otherwise it is with the bot the
 * message names, which a chip puts in it, or between people when it names
 * none. Sending starts the thread and opens it.
 */
export function NewThread({
	pod,
	userId,
	agentHandle,
}: {
	pod: Pod;
	userId: string;
	agentHandle?: string;
}) {
	const podChat = useOpenPodChat(pod);
	const details = useThread(podChat.data?.id).data;
	// Files are uploaded to the pod's chat, and move to the thread when it starts.
	const attachments = useComposerAttachments(podChat.data?.id);
	const threads = useThreadStarter(podChat.data?.id, attachments);
	const navigate = useNavigate();
	const [draft, setDraft] = useState("");
	const [failed, setFailed] = useState(false);
	// The bot it was opened from, from the roster the sidebar has already loaded.
	const { agents } = useAgents();
	const chosen = agentHandle
		? agents?.find((agent) => agent.podId === pod.id && agent.handle === agentHandle)
		: undefined;
	const threadWith = chosen ?? (details ? firstBotNamed(draft, details.crew) : undefined);
	// The model that answers: the chosen bot's, or the named one's, from the roster.
	const threadWithModel = useModelName(
		agents?.find((agent) => agent.id === threadWith?.id)?.model ?? null,
	);
	const title = agentHandle ? "New thread" : `New thread in ${pod.name}`;
	// The page names itself in its middle; the header is kept on a phone for its Back.
	const header = (
		<div className="md:hidden">
			<PeopleChatHeader title={title} back={{ to: "pod", pod }} />
		</div>
	);

	if (podChat.isError) {
		return (
			<div className="flex min-w-0 flex-1 flex-col">
				{header}
				<EmptyState title="Could not start a thread here">
					The API did not answer. Reload this page to try again.
				</EmptyState>
			</div>
		);
	}

	const mentionable = details
		? mentionableIn(details).filter((candidate) => candidate.id !== userId)
		: [];
	const bots = details?.crew.filter(
		(member): member is AgentParticipant => member.kind === "agent",
	);

	async function submit() {
		setFailed(false);
		const started = await threads.start(draft, { hostAgentId: threadWith?.id });
		if (started.outcome === "refused") setFailed(true);
		if (started.outcome !== "started") return;
		await navigate(conversationLink({ pod, conversationId: started.thread.conversation.id }));
	}

	const composer = (
		<ChatComposer
			label={threadWith ? `Message ${threadWith.name}` : `Message ${pod.name}`}
			placeholder={chosen ? "Describe the task, paste a link or drop a file" : undefined}
			model={threadWithModel ?? undefined}
			value={draft}
			onValueChange={setDraft}
			onSubmit={submit}
			submitLabel="Start thread"
			sending={threads.isPending}
			needsText
			error={failed ? THREAD_NOT_STARTED : undefined}
			className="w-full"
			mentionable={mentionable}
			attachments={attachments}
		/>
	);

	// Opened from a bot: a question for it, with the box to answer it in, in the middle of the page.
	if (agentHandle) {
		return (
			<div className="flex min-w-0 flex-1 flex-col">
				{header}
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-5 pb-[12%]">
					{chosen && (
						<div className="flex w-full max-w-[640px] flex-col items-center gap-6">
							<div className="flex flex-col items-center gap-2 text-center">
								<AgentAvatar
									color={chosen.color}
									face={chosen.face}
									shape={chosen.shape}
									size={64}
									className="mb-3"
								/>
								<h2 className="m-0 font-semibold text-[18px] text-foreground">
									What should {chosen.name} work on?
								</h2>
								{chosen.description && (
									<p className="m-0 text-[13px] text-muted-foreground">{chosen.description}</p>
								)}
							</div>
							{composer}
						</div>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="flex min-w-0 flex-1 flex-col">
			{header}
			<div className="flex min-h-0 flex-1 flex-col justify-end gap-4 overflow-y-auto px-5 pt-6 pb-4">
				<div className="flex flex-col gap-1.5">
					<h2 className="m-0 font-bold text-[22px] text-foreground leading-tight">{title}</h2>
					<p className="m-0 text-[14px] text-muted-foreground">
						Name a bot to start the thread with it, or write to the people here.
					</p>
				</div>
				{bots && bots.length > 0 && (
					<ul aria-label="Bots" className="m-0 flex list-none flex-wrap gap-2 p-0">
						{bots.map((bot) => (
							<li key={bot.id}>
								<button
									type="button"
									onClick={() => setDraft((current) => `@${bot.handle} ${current.trimStart()}`)}
									className="focus-ring flex h-8 items-center gap-2 rounded-[8px] border border-border-strong pr-3 pl-1.5 font-medium text-[13.5px] text-foreground transition-colors hover:bg-row-hover"
								>
									<AgentAvatar color={bot.color} face={bot.face} shape={bot.shape} size={20} />
									{bot.name}
								</button>
							</li>
						))}
					</ul>
				)}
			</div>
			<div className="shrink-0 px-4 md:px-5">
				{composer}
				<div className="flex h-[26px] items-center">
					<p className="m-0 px-1 text-[12.5px] text-muted-foreground">
						{threadWith
							? `Sending starts a thread with ${threadWith.name}.`
							: "Sending starts a thread with the people here."}
					</p>
				</div>
			</div>
		</div>
	);
}
