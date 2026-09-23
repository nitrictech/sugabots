import type { RoutineExecutionTriggerKind } from "@sugabots/contracts";
import { type ChatThreadType, ThreadTypeMark, threadTypePresentation } from "./ChatActivityRow.tsx";

export function HistoryThreadTile({
	type,
	triggerKind,
	size = 13,
}: {
	type: ChatThreadType;
	triggerKind?: RoutineExecutionTriggerKind;
	size?: number;
}) {
	return (
		<span
			className="grid size-[26px] shrink-0 place-items-center rounded-lg"
			style={{ background: threadTypePresentation[type].tint }}
		>
			<ThreadTypeMark type={type} triggerKind={triggerKind} size={size} />
		</span>
	);
}
