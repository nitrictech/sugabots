export function Toggle({
	checked,
	disabled,
	label,
	onChange,
}: {
	checked: boolean;
	disabled?: boolean;
	label: string;
	onChange: (checked: boolean) => void;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={`focus-ring relative h-[26px] w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-150 disabled:cursor-default disabled:opacity-45 ${checked ? "bg-switch-on" : "bg-border-strong"}`}
		>
			<span
				className={`absolute top-[3px] left-[3px] size-5 rounded-full bg-white transition-transform duration-150 ${checked ? "translate-x-[18px]" : ""}`}
			/>
		</button>
	);
}
