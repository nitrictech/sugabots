import type { BotLook } from "@sugabots/avatars";
import { BotAvatar } from "@/components/bot-avatar";
import { Reveal, RevealItem } from "@/components/reveal";

interface SystemAgent {
	name: string;
	look: BotLook;
	job: string;
}

/** The two behind-the-scenes agents, as packages/web/src/lib/built-in-agents.ts shows them. */
const systemAgents: readonly SystemAgent[] = [
	{
		name: "Scribe",
		look: { color: "orange", face: "arc" },
		job: "Keeps concise summaries of ongoing conversations, and titles them.",
	},
	{
		name: "Facilitator",
		look: { color: "teal", face: "pill" },
		job: "Decides who speaks next when nobody was addressed.",
	},
];

export function SystemAgents() {
	return (
		<Reveal className="my-8 grid gap-3 sm:grid-cols-2">
			{systemAgents.map(({ name, look, job }) => (
				<RevealItem
					key={name}
					className="flex items-start gap-4 rounded-3xl bg-card p-5 ring-1 ring-foreground/10"
				>
					<BotAvatar size="lg" {...look} />
					<span className="flex flex-col gap-1">
						<span className="text-lg font-bold">{name}</span>
						<span className="text-sm text-muted-foreground">{job}</span>
					</span>
				</RevealItem>
			))}
		</Reveal>
	);
}
