import type { RoutineTrigger } from "@sugabots/contracts";
import {
	DialogFormBody,
	DialogFormFooter,
	DialogFormHeader,
	DialogFormStep,
} from "@/ui/dialog-form.tsx";
import { SettingsGroup, SettingsRow, SettingsRowIcon } from "@/ui/settings-page.tsx";
import { RoutineTriggerIcon } from "./ChatActivityRow.tsx";

/* The kinds of trigger a routine may have, which the first step of adding one lists. */

export type TriggerKind = RoutineTrigger["kind"];

export interface TriggerKindChoice {
	readonly kind: TriggerKind;
	readonly label: string;
	readonly sub: string;
}

/** Every kind of trigger, in the order the dialog lists them. */
export const TRIGGER_KINDS: readonly TriggerKindChoice[] = [
	{ kind: "cron", label: "Schedule", sub: "On the days and at the times you pick" },
	{ kind: "webhook", label: "Webhook", sub: "When something calls its address" },
];

export function triggerKindChoice(kind: TriggerKind): TriggerKindChoice {
	const found = TRIGGER_KINDS.find((choice) => choice.kind === kind);
	if (!found) throw new Error(`No such kind of trigger: ${kind}`);
	return found;
}

/** A kind of trigger's mark. */
export function TriggerKindMark({ choice }: { choice: TriggerKindChoice }) {
	return (
		<SettingsRowIcon className="size-[34px] rounded-[10px]">
			<RoutineTriggerIcon kind={choice.kind} size={15} strokeWidth={2.2} />
		</SettingsRowIcon>
	);
}

/** The first step of adding a trigger: choosing its kind. */
export function TriggerKindStep({
	onChoose,
	done,
}: {
	onChoose: (kind: TriggerKind) => void;
	done: () => void;
}) {
	return (
		<DialogFormStep onSubmit={(event) => event.preventDefault()}>
			<DialogFormHeader title="Add a trigger" />
			<DialogFormBody>
				<SettingsGroup>
					{TRIGGER_KINDS.map((choice) => (
						<SettingsRow
							key={choice.kind}
							icon={<TriggerKindMark choice={choice} />}
							label={choice.label}
							sub={choice.sub}
							chevron
							onClick={() => onChoose(choice.kind)}
						/>
					))}
				</SettingsGroup>
			</DialogFormBody>
			<DialogFormFooter onCancel={done} />
		</DialogFormStep>
	);
}
