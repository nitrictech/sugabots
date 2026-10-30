import type { ConnectionKind, Pod, RoutineTrigger } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Search } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { useConnections } from "@/lib/connections.ts";
import { podSettingsLink } from "@/lib/links.ts";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { DialogFormBody, DialogFormHeader, DialogFormStep } from "@/ui/dialog-form.tsx";
import { SettingsGroup, SettingsRow, SettingsRowIcon } from "@/ui/settings-page.tsx";
import { RoutineTriggerIcon } from "./ChatActivityRow.tsx";

/*
 * The kinds of trigger a routine may have: Sugabots' own, and those of the
 * integrations its bot's pod connects to. There may be many, so the
 * first step of adding one is a searchable list of only those the pod can use.
 */

export type TriggerKind = RoutineTrigger["kind"];

export interface TriggerKindChoice {
	readonly kind: TriggerKind;
	readonly label: string;
	readonly sub: string;
	/** The kind of connection the bot's pod needs for it, for an integration's trigger. */
	readonly connection?: ConnectionKind;
}

/** Every kind of trigger, Sugabots' own first, in the order the dialog lists them. */
export const TRIGGER_KINDS: readonly TriggerKindChoice[] = [
	{ kind: "cron", label: "Schedule", sub: "On the days and at the times you pick" },
	{ kind: "webhook", label: "Webhook", sub: "When something calls its address" },
	{
		kind: "github",
		label: "GitHub",
		sub: "When something happens on a repository: pull requests, issues, checks, pushes",
		connection: "github",
	},
];

export function triggerKindChoice(kind: TriggerKind): TriggerKindChoice {
	const found = TRIGGER_KINDS.find((choice) => choice.kind === kind);
	if (!found) throw new Error(`No such kind of trigger: ${kind}`);
	return found;
}

/** A kind of trigger's mark: its integration's logo, or an icon for Sugabots' own. */
export function TriggerKindMark({ choice }: { choice: TriggerKindChoice }) {
	if (choice.connection) {
		return <ConnectionMark presetId={choice.connection} name={choice.label} size="tile" />;
	}
	return (
		<SettingsRowIcon className="size-[34px] rounded-[10px]">
			<RoutineTriggerIcon kind={choice.kind} size={15} strokeWidth={2.2} />
		</SettingsRowIcon>
	);
}

/**
 * The first step of adding a trigger: choosing its kind, found by typing part
 * of its name, from Sugabots' own and those of the integrations `pod` is
 * connected to, with a way to connect it to more.
 */
export function TriggerKindStep({
	pod,
	onChoose,
	done,
}: {
	/** The bot's pod; undefined while no bot is chosen, which leaves only Sugabots' own. */
	pod: Pod | undefined;
	onChoose: (kind: TriggerKind) => void;
	done: () => void;
}) {
	const connections = useConnections(pod?.id);
	const connected = new Set(connections.data?.map((one) => one.kind));
	const [query, setQuery] = useState("");
	const needle = useDeferredValue(query.trim().toLowerCase());
	const matches = (choice: TriggerKindChoice) =>
		needle === "" ||
		choice.label.toLowerCase().includes(needle) ||
		choice.sub.toLowerCase().includes(needle);
	const own = TRIGGER_KINDS.filter((choice) => !choice.connection && matches(choice));
	const integrations = TRIGGER_KINDS.filter(
		(choice) => choice.connection && connected.has(choice.connection) && matches(choice),
	);
	const row = (choice: TriggerKindChoice) => (
		<SettingsRow
			key={choice.kind}
			icon={<TriggerKindMark choice={choice} />}
			label={choice.label}
			sub={choice.sub}
			chevron
			onClick={() => onChoose(choice.kind)}
		/>
	);
	return (
		<DialogFormStep onSubmit={(event) => event.preventDefault()}>
			<DialogFormHeader title="Add a trigger" onClose={done} />
			<DialogFormBody>
				<label className="focus-ring-within flex items-center gap-[9px] rounded-xl bg-chip px-3">
					<Search aria-hidden size={15} className="shrink-0 text-muted-foreground" />
					<input
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search triggers"
						aria-label="Search triggers"
						className="min-w-0 flex-1 bg-transparent py-[9px] text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
					/>
				</label>
				<div className="-mx-1 flex max-h-[min(480px,60vh)] flex-col gap-5 overflow-y-auto px-1">
					{own.length > 0 && <SettingsGroup label="Built in">{own.map(row)}</SettingsGroup>}
					{pod && (
						<SettingsGroup label="From this pod's connections">
							{integrations.map(row)}
							{/* Set as the kinds above are, a name and a line under it, so the dialog keeps to their two styles. */}
							<SettingsRow
								label={
									integrations.length > 0
										? "Connect another app"
										: needle === ""
											? "No connections with triggers yet"
											: `No connection matches “${query.trim()}”`
								}
								sub={
									integrations.length > 0
										? `In ${pod.name}'s settings`
										: `Connect an app in ${pod.name}'s settings`
								}
								trailing={
									<ArrowUpRight aria-hidden size={15} className="shrink-0 text-subtle-foreground" />
								}
								render={<Link {...podSettingsLink(pod)} />}
							/>
						</SettingsGroup>
					)}
				</div>
			</DialogFormBody>
		</DialogFormStep>
	);
}
