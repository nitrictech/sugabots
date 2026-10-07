import { Tooltip } from "./tooltip.tsx";

export function Toggle({
	checked,
	disabled,
	label,
	tooltip,
	onChange,
}: {
	checked: boolean;
	disabled?: boolean;
	label: string;
	/** Text shown on hover. Pass what a click does, or, while disabled, why the switch cannot be changed. */
	tooltip?: string;
	onChange: (checked: boolean) => void;
}) {
	const toggle = (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={`focus-ring relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors duration-150 disabled:cursor-default disabled:opacity-45 ${checked ? "bg-switch-on" : "bg-border-strong"}`}
		>
			<span
				className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white transition-transform duration-150 ${checked ? "translate-x-4" : ""}`}
			/>
		</button>
	);
	if (tooltip === undefined) return toggle;
	return (
		<Tooltip label={tooltip} side="top">
			{/*
			 * The tooltip hangs on a wrapper because a disabled button receives no
			 * mouse events. The wrapper stays when the switch is enabled too: Tooltip
			 * attaches its hover listeners to the element it first renders, so
			 * swapping the button for a wrapper when `disabled` turns true would leave
			 * the listeners on a removed element and the tooltip would never open.
			 */}
			<span className="inline-flex shrink-0">{toggle}</span>
		</Tooltip>
	);
}
