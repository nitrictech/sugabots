import type { Agent } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { Pin, PinOff, Plus } from "lucide-react";
import { useAgents, usePinAgent } from "@/lib/agents.ts";
import { failureMessage } from "@/lib/failure.ts";
import { agentSettingsLink, botLink } from "@/lib/links.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { useNewBot } from "@/shell/NewInPod.tsx";
import { Page } from "@/shell/Page.tsx";
import { Alert } from "@/ui/alert.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsGroup, SettingsRow, SettingsValue } from "@/ui/settings-page.tsx";

/**
 * Every bot the person reaches: their Personal Assistant, the public bots
 * and their own private ones, each opening the bot, with a pin that puts it
 * in the sidebar or takes it out. A + makes another.
 */
export function BotsDirectory() {
	const { agents, isPending, error } = useAgents();
	const pin = usePinAgent();
	const newBot = useNewBot();
	const bots = (agents ?? []).filter((agent) => agent.systemAgentKey === null);
	const assistant = bots.filter((agent) => agent.assistant);
	const rest = bots.filter((agent) => !agent.assistant);
	return (
		<Page
			title="Bots"
			place={{ kind: "tab" }}
			actions={
				newBot.start && (
					<IconButton label="New bot" variant="bar" onClick={newBot.start}>
						<Plus size={16} strokeWidth={1.75} />
					</IconButton>
				)
			}
		>
			<div className="mx-auto flex w-full max-w-180 flex-col gap-6 px-4 pt-6 pb-12">
				{error ? <Alert>{failureMessage(error)}</Alert> : null}
				{pin.error ? <Alert>{failureMessage(pin.error)}</Alert> : null}
				{assistant.length > 0 && (
					<SettingsGroup label="Yours" headingLevel={2}>
						{assistant.map((agent) => (
							<BotRow key={agent.id} agent={agent} />
						))}
					</SettingsGroup>
				)}
				{!isPending && rest.length === 0 ? (
					<EmptyState title="No bots yet">
						{newBot.start ? "Make the first one with the + above." : "Nobody has made one yet."}
					</EmptyState>
				) : (
					rest.length > 0 && (
						<SettingsGroup label="In this workspace" headingLevel={2}>
							{rest.map((agent) => (
								<BotRow
									key={agent.id}
									agent={agent}
									onPin={(pinned) => pin.mutate({ agentId: agent.id, pinned })}
									pinning={pin.isPending && pin.variables?.agentId === agent.id}
								/>
							))}
						</SettingsGroup>
					)
				)}
			</div>
			{newBot.dialog}
		</Page>
	);
}

/**
 * A bot in the directory: its face, name and what it's for, with its pin.
 * The name opens the bot, or, for someone else's private bot an
 * administrator only sees listed, its settings; the pin sits beside it, so no
 * button is inside a link.
 */
function BotRow({
	agent,
	onPin,
	pinning = false,
}: {
	agent: Agent;
	/** Pins or unpins it; absent for the Personal Assistant, which is always at the sidebar's top. */
	onPin?: (pinned: boolean) => void;
	pinning?: boolean;
}) {
	const usable = agent.permissions.talk;
	const nameClassName = "focus-ring rounded-sm hover:underline";
	return (
		<SettingsRow
			icon={<AgentAvatar color={agent.color} face={agent.face} shape={agent.shape} size={24} />}
			label={
				usable ? (
					<Link {...botLink(agent)} className={nameClassName}>
						{agent.name}
					</Link>
				) : agent.permissions.update ? (
					<Link {...agentSettingsLink(agent)} className={nameClassName}>
						{agent.name}
					</Link>
				) : (
					agent.name
				)
			}
			sub={
				agent.assistant
					? "Your Personal Assistant"
					: [
							agent.visibility === "private"
								? usable
									? "Private"
									: "Someone else's private bot"
								: null,
							agent.description,
						]
							.filter(Boolean)
							.join(" · ") || undefined
			}
			trailing={
				!usable ? null : onPin ? (
					<IconButton
						label={agent.pinned ? `Unpin ${agent.name}` : `Pin ${agent.name}`}
						size="sm"
						disabled={pinning}
						onClick={() => onPin(!agent.pinned)}
					>
						{agent.pinned ? <PinOff strokeWidth={2} /> : <Pin strokeWidth={2} />}
					</IconButton>
				) : (
					<SettingsValue>Always pinned</SettingsValue>
				)
			}
		/>
	);
}
