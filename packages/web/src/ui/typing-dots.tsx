import { cn } from "cn";

/**
 * Three dots rising in turn, as somebody typing or a bot at work is shown.
 * Hidden from assistive technology: whatever holds them says who is at work.
 */
export function TypingDots({ className }: { className?: string }) {
	return (
		<span aria-hidden className={cn("typing-dots typing-dots-small", className)}>
			<i />
			<i />
			<i />
		</span>
	);
}
