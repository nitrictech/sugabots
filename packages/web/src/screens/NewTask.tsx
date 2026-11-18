import type { Bot } from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useModelName } from "@/lib/bots.ts";
import { TASK_NOT_STARTED, useTaskStarter } from "@/lib/chats.ts";
import { useComposerAttachments } from "@/lib/composer-attachments.ts";
import { conversationLink } from "@/lib/links.ts";
import { WatchingAvatar } from "@/shell/Bot.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { ChatComposer } from "./ChatComposer.tsx";
import { PeopleChatHeader } from "./ChatHeader.tsx";
import { groupMentionsBy } from "./mentions.tsx";

/**
 * Starting a task with a bot from its first message: what the bot should work
 * on, asked in the middle of the page, with the box to answer it in. Sending
 * starts the task and opens it. Files are added once it has started.
 */
export function NewTask({ bot, userId }: { bot: Bot; userId: string }) {
	// A task has nowhere to upload to until it starts.
	const attachments = useComposerAttachments(undefined);
	const tasks = useTaskStarter(bot.id);
	const navigate = useNavigate();
	const [draft, setDraft] = useState("");
	const [failed, setFailed] = useState(false);
	const modelName = useModelName(bot.model);
	// The page names itself in its middle; the header is kept on a phone for its Back.
	const header = (
		<div className="md:hidden">
			<PeopleChatHeader title="New task" back={{ to: "bot", bot }} />
		</div>
	);
	const mentionable = groupMentionsBy({ kind: "person", id: userId }, [], "task");

	async function submit() {
		setFailed(false);
		const started = await tasks.start(draft);
		if (started.outcome === "refused") setFailed(true);
		if (started.outcome !== "started") return;
		await navigate(conversationLink({ bot, conversationId: started.task.conversation.id }));
	}

	return (
		<div className="flex min-w-0 flex-1 flex-col">
			{header}
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-5 pb-24">
				<div className="flex w-full max-w-160 flex-col items-center gap-6">
					<div className="flex flex-col items-center gap-2 text-center">
						{/* It watches the question being written, and thinks while the task starts. */}
						<WatchingAvatar bot={bot} size={64} busy={tasks.isPending} watching className="mb-3" />
						<h2 className="m-0 font-semibold text-lg text-foreground">
							What should {bot.name} work on?
						</h2>
						{bot.description && (
							<p className="m-0 text-xs text-muted-foreground">{bot.description}</p>
						)}
					</div>
					{bot.model === null ? (
						<EmptyState title={`${bot.name} has no model yet`}>
							Somebody who can change {bot.name} chooses its model in its settings.
						</EmptyState>
					) : (
						<ChatComposer
							label={`Message ${bot.name}`}
							placeholder="Describe the task or paste a link"
							model={modelName ?? undefined}
							value={draft}
							onValueChange={setDraft}
							onSubmit={submit}
							submitLabel="Start task"
							sending={tasks.isPending}
							needsText
							error={failed ? TASK_NOT_STARTED : undefined}
							className="w-full"
							mentionable={mentionable}
							attachments={attachments}
						/>
					)}
				</div>
			</div>
		</div>
	);
}
