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
			className={`focus-ring relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-default disabled:opacity-45 ${checked ? "bg-primary" : "bg-border"}`}
		>
			<span
				className={`absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-5" : ""}`}
			/>
		</button>
	);
}
