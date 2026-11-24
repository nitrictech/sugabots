/** A word beside a name saying what it names: a bot, or a member's role. */
export function TitleTag({ children }: { children: string }) {
	return (
		<span className="shrink-0 rounded bg-chip px-1.25 py-px font-semibold text-2xs text-muted-foreground leading-snug">
			{children}
		</span>
	);
}
