import type { Agent } from "@sugabots/contracts";
import { Monitor } from "lucide-react";
import { useDesktopInUse } from "@/lib/desktop.ts";
import { useSandboxAccess } from "@/lib/sandbox-providers.ts";
import { IconButton } from "@/ui/icon-button.tsx";

/**
 * The bot's computer, for the top of its chat: always there, so it opens to
 * say how to get one when the workspace or the bot has none.
 */
export function ChatSandbox({
	agent,
	threadId,
	onOpen,
}: {
	agent: Agent;
	/** The conversation the bot's desktop is watched from. */
	threadId: string;
	onOpen: () => void;
}) {
	return (
		<SandboxButton
			agentName={agent.name}
			inUse={useSandboxInUse(agent, threadId)}
			onOpen={onOpen}
		/>
	);
}

/**
 * The bot's computer at the top right of its chat on a phone: a round, frosted
 * button, with a pulse in the bot's colour at its corner while the bot uses it.
 */
export function PhoneChatSandbox({
	agent,
	threadId,
	onOpen,
}: {
	agent: Agent;
	/** The conversation the bot's desktop is watched from. */
	threadId: string;
	onOpen: () => void;
}) {
	const inUse = useSandboxInUse(agent, threadId);
	return (
		<button
			type="button"
			onClick={onOpen}
			aria-label={
				inUse ? `${agent.name} is using the sandbox. Open its desktop` : `${agent.name}'s computer`
			}
			className="focus-ring glass relative grid size-9 shrink-0 place-items-center rounded-full text-foreground"
		>
			<Monitor aria-hidden size={17} strokeWidth={1.75} />
			{inUse && (
				<span aria-hidden className="absolute top-0 right-0 flex size-2.5">
					<span className="absolute inline-flex size-full animate-ping rounded-full bg-bot-mono opacity-60 motion-reduce:animate-none" />
					<span className="relative inline-flex size-2.5 rounded-full bg-bot-mono" />
				</span>
			)}
		</button>
	);
}

/** Whether the bot is using its sandbox's desktop in this conversation right now. */
function useSandboxInUse(agent: Agent, threadId: string): boolean {
	const sandboxesOn = useSandboxAccess().data?.enabled === true;
	const inUse = useDesktopInUse(threadId, agent.id);
	return agent.usesSandbox && sandboxesOn && inUse;
}

/**
 * The way into an agent's sandbox desktop from the top of its chat, there at
 * any time. While the agent is using the desktop it says so in the bot's
 * colour, with a pulse, so people notice there's something to watch.
 */
export function SandboxButton({
	agentName,
	inUse,
	onOpen,
}: {
	agentName: string;
	/** Whether the agent is using the desktop right now. */
	inUse: boolean;
	onOpen: () => void;
}) {
	return inUse ? (
		<button
			type="button"
			onClick={onOpen}
			aria-label={`${agentName} is using the sandbox. Open its desktop`}
			className="focus-ring flex h-8 shrink-0 items-center gap-2 rounded-[8px] bg-bot-tint px-3 font-medium text-bot-text text-sm transition-colors"
		>
			<span aria-hidden className="relative flex size-2">
				<span className="absolute inline-flex size-full animate-ping rounded-full bg-bot-mono opacity-60 motion-reduce:animate-none" />
				<span className="relative inline-flex size-2 rounded-full bg-bot-mono" />
			</span>
			Sandbox in use
		</button>
	) : (
		<IconButton
			label="Computer"
			variant="bar"
			onClick={onOpen}
			className="text-muted-foreground hover:text-foreground"
		>
			<Monitor size={16} strokeWidth={1.75} />
		</IconButton>
	);
}
