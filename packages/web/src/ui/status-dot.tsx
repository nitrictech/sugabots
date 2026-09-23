import { Tooltip } from "@/ui/tooltip.tsx";

/*
 * Whether a thing in a settings rail is usable: a filled green dot when it is,
 * an empty grey ring when it is not. The rail row already names the thing, so
 * the dot carries only the state. `label` is that state in a word or two, read
 * as part of the row's name; `tooltip` says what it means for this thing.
 */
export function StatusDot({ on, label, tooltip }: { on: boolean; label: string; tooltip: string }) {
	return (
		<>
			<Tooltip label={tooltip}>
				<span
					aria-hidden="true"
					className={`size-2 shrink-0 rounded-full ${
						on ? "bg-success" : "border border-muted-foreground/50"
					}`}
				/>
			</Tooltip>
			<span className="sr-only">{label}</span>
		</>
	);
}
