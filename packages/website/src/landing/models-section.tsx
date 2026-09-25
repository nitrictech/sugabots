import type { BotLook } from "@sugabots/avatars";
import type { ProviderPresetId } from "@sugabots/contracts";
import { ProviderLogo } from "@sugabots/provider-logos";
import { BotAvatar } from "@/components/bot-avatar";
import { Emphasis } from "@/components/emphasis";
import { Reveal, RevealItem } from "@/components/reveal";
import { Section } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from "@/components/ui/item";
import { bots } from "@/landing/bots";

interface Model {
	name: string;
	host: string;
	/** The provider whose logo sits beside the model's name. */
	provider: ProviderPresetId;
}

interface Assignment {
	bot: BotLook;
	name: string;
	job: string;
	model: Model;
}

const assignments: readonly Assignment[] = [
	{
		bot: bots.copywriter,
		name: "Copywriter",
		job: "Drafts replies, posts and invites",
		model: {
			name: "ChatGPT",
			host: "OpenAI",
			provider: "openai",
		},
	},
	{
		bot: bots.researcher,
		name: "Researcher",
		job: "Reads the long stuff so you don't have to",
		model: {
			name: "Claude",
			host: "Anthropic",
			provider: "anthropic",
		},
	},
	{
		bot: bots.inboxSorter,
		name: "Inbox Sorter",
		job: "Triage, reminders and other quick jobs",
		model: {
			name: "Gemini Flash",
			host: "Google",
			provider: "gemini",
		},
	},
	{
		bot: bots.journal,
		name: "Journal",
		job: "Private notes that stay private",
		model: {
			name: "Llama",
			host: "Ollama on your machine",
			provider: "ollama",
		},
	},
];

export function ModelsSection() {
	return (
		<Section
			eyebrow="Any model"
			tone="orange"
			title="The right brain for every bot."
			description={
				<>
					Sign in with your <Emphasis tone="orange">ChatGPT</Emphasis> subscription, bring API keys
					for <Emphasis tone="orange">Anthropic</Emphasis>,{" "}
					<Emphasis tone="orange">Google</Emphasis> and more, or run local models with{" "}
					<Emphasis tone="orange">Ollama</Emphasis>. Each agent can use a different model.
				</>
			}
		>
			<Reveal>
				<ItemGroup className="gap-0 divide-y">
					{assignments.map(({ bot, name, job, model }) => (
						<Item
							key={name}
							role="listitem"
							render={<RevealItem />}
							className="flex-nowrap items-start rounded-none px-0 py-4 sm:items-center"
						>
							<ItemMedia>
								<BotAvatar size="lg" {...bot} />
							</ItemMedia>
							{/* The model sits under the bot's details on small screens, beside them from sm up. */}
							<div className="flex min-w-0 flex-1 flex-col items-start gap-2 sm:flex-row sm:items-center">
								<ItemContent className="gap-0">
									<ItemTitle className="text-base font-semibold">{name}</ItemTitle>
									<ItemDescription>{job}</ItemDescription>
								</ItemContent>
								<ItemActions className="max-w-full">
									<Badge variant="outline" size="lg" className="max-w-full bg-card pl-2.5">
										<ProviderLogo preset={model.provider} className="size-5" />
										{model.name}
										<span className="truncate text-muted-foreground">{model.host}</span>
									</Badge>
								</ItemActions>
							</div>
						</Item>
					))}
				</ItemGroup>
			</Reveal>
		</Section>
	);
}
