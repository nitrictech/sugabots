import type { Agent, Pod } from "@sugabots/contracts";
import { Laptop } from "lucide-react";
import { useChat } from "@/lib/chats.ts";
import { useLendMyDevice, useMyDevice } from "@/lib/my-device.ts";
import { IconButton } from "@/ui/icon-button.tsx";

/**
 * Lending the person's own computer to the chat's bots, for the top of the
 * chat: there while their desktop app is connected. Only they see it, and
 * their desktop still asks them before running anything.
 */
export function ChatMyDevice({ agent, pod }: { agent: Agent; pod: Pod }) {
	const threadId = useChat(pod, agent.id).data?.mainThreadId;
	const lending = useMyDevice(threadId).data;
	if (!threadId || !lending?.connected) return null;
	return (
		<MyDeviceToggle
			threadId={threadId}
			name={lending.name ?? "your computer"}
			lent={lending.lent}
		/>
	);
}

function MyDeviceToggle({
	threadId,
	name,
	lent,
}: {
	threadId: string;
	name: string;
	lent: boolean;
}) {
	const lend = useLendMyDevice(threadId);
	return lent ? (
		<button
			type="button"
			onClick={() => lend.mutate(false)}
			disabled={lend.isPending}
			aria-label={`Bots here can use ${name}. Stop lending it`}
			className="focus-ring flex h-8 shrink-0 items-center gap-2 rounded-full bg-bot-tint px-3 font-medium text-bot-text text-sm transition-colors max-md:px-2.5"
		>
			<Laptop aria-hidden size={17} strokeWidth={2} />
			<span className="max-md:hidden">Using {name}</span>
		</button>
	) : (
		<IconButton
			label={`Let bots here use ${name}`}
			variant="bar"
			onClick={() => lend.mutate(true)}
			disabled={lend.isPending}
			className="size-8"
		>
			<Laptop size={18} strokeWidth={2} />
		</IconButton>
	);
}
