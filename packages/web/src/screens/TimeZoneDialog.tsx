import type { TimeZone } from "@sugabots/contracts";
import { Check, Search } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import {
	type TimeZoneChoice,
	type TimeZoneRegion,
	timeZoneChoices,
	timeZonePlace,
	timeZoneRegions,
} from "@/lib/time-zones.ts";
import {
	browserTimeZone,
	useChangeWorkspaceTimeZone,
	useWorkspaceTimeZone,
} from "@/lib/workspace.ts";
import { Alert } from "@/ui/alert.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	DialogFormBody,
	DialogFormFooter,
	DialogFormFrame,
	DialogFormHeader,
	DialogFormStep,
} from "@/ui/dialog-form.tsx";
import { Note } from "@/ui/note.tsx";
import { SettingsGroup, SettingsRow, SettingsValue } from "@/ui/settings-page.tsx";

/**
 * Choosing the workspace's time zone: this device's, or one from a region,
 * or any found by typing part of its name. When routines are scheduled on its
 * time, it says from the start that they move with it, so choosing a zone
 * doesn't resize it.
 */
export function TimeZoneDialog({
	workspaceId,
	current,
	open,
	onOpenChange,
}: {
	workspaceId: string;
	current: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogFormFrame>
				{open && (
					<TimeZoneStep
						workspaceId={workspaceId}
						current={current}
						done={() => onOpenChange(false)}
					/>
				)}
			</DialogFormFrame>
		</Dialog>
	);
}

function TimeZoneStep({
	workspaceId,
	current,
	done,
}: {
	workspaceId: string;
	current: string;
	done: () => void;
}) {
	const scheduled = useWorkspaceTimeZone(workspaceId, true).data?.scheduledRoutines ?? 0;
	const change = useChangeWorkspaceTimeZone(workspaceId);
	const choices = useMemo(() => timeZoneChoices(new Date()), []);
	const regions = useMemo(() => timeZoneRegions(choices), [choices]);
	const [region, setRegion] = useState<TimeZoneRegion | undefined>();
	const [chosen, setChosen] = useState<TimeZone | undefined>();
	const [query, setQuery] = useState("");
	const needle = useDeferredValue(query.trim().toLowerCase());
	const device = browserTimeZone();
	const deviceChoice = choices.find((choice) => choice.zone === device);
	const selected = chosen ?? current;
	const moving = chosen !== undefined && chosen !== current;

	async function save() {
		if (!moving) return;
		try {
			await change.mutateAsync(chosen);
		} catch {
			return;
		}
		done();
	}

	function browse(next: TimeZoneRegion | undefined) {
		setRegion(next);
		setQuery("");
	}

	const zoneRow = (choice: TimeZoneChoice) => (
		<SettingsRow
			key={choice.zone}
			label={choice.place}
			sub={choice.zone}
			trailing={
				<>
					<SettingsValue>{choice.offset}</SettingsValue>
					<Check
						aria-hidden
						size={16}
						strokeWidth={2.4}
						className={choice.zone === selected ? "shrink-0 text-link" : "invisible shrink-0"}
					/>
					{choice.zone === selected && <span className="sr-only">Chosen</span>}
				</>
			}
			onClick={() => setChosen(choice.zone)}
		/>
	);

	const regionRow = (each: TimeZoneRegion) => {
		const selectedHere = each.choices.find((choice) => choice.zone === selected);
		return (
			<SettingsRow
				key={each.name}
				label={each.name}
				// The chosen zone in place of the count, so every row keeps one height.
				trailing={
					<SettingsValue>{selectedHere?.place ?? `${each.choices.length} zones`}</SettingsValue>
				}
				chevron
				onClick={() => browse(each)}
			/>
		);
	};

	const searched = (region?.choices ?? choices).filter((choice) => matches(choice, needle));
	const searchLabel = `Search ${region ? region.name : "time zones"}`;

	return (
		<DialogFormStep
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<DialogFormHeader
				title={region?.name ?? "Time zone"}
				onBack={region ? () => browse(undefined) : undefined}
			/>
			<DialogFormBody>
				<label className="focus-ring-within flex items-center gap-[9px] rounded-xl bg-chip px-3">
					<Search aria-hidden size={15} className="shrink-0 text-muted-foreground" />
					<input
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={searchLabel}
						aria-label={searchLabel}
						className="min-w-0 flex-1 bg-transparent py-[9px] text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
					/>
				</label>
				{/* One height on every step, so going into a region and back doesn't resize the dialog. */}
				<div className="-mx-1 flex h-[min(432px,55vh)] flex-col gap-5 overflow-y-auto px-1">
					{needle === "" && !region ? (
						<>
							{deviceChoice && <SettingsGroup>{zoneRow(deviceChoice)}</SettingsGroup>}
							<SettingsGroup label="Regions">{regions.map(regionRow)}</SettingsGroup>
						</>
					) : (
						<SettingsGroup>
							{searched.map(zoneRow)}
							{searched.length === 0 && (
								<SettingsRow label={`No time zone matches “${query.trim()}”`} />
							)}
						</SettingsGroup>
					)}
				</div>
				{scheduled > 0 && (
					<Note>
						All routines scheduled on {timeZonePlace(current)} time will now run in whichever zone
						you pick.
					</Note>
				)}
				{change.error && <Alert>{failureMessage(change.error)}</Alert>}
			</DialogFormBody>
			<DialogFormFooter
				action={change.isPending ? "Saving…" : "Save"}
				actionDisabled={!moving || change.isPending}
				cancelDisabled={change.isPending}
			/>
		</DialogFormStep>
	);
}

/** Whether `needle` is in the zone's name, read with spaces for its underscores, or in its offset. */
function matches(choice: TimeZoneChoice, needle: string): boolean {
	if (needle === "") return true;
	return (
		choice.zone.toLowerCase().replaceAll("_", " ").includes(needle) ||
		choice.offset.toLowerCase().includes(needle)
	);
}
