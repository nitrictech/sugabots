/**
 * A dot in the bot's colour with a ring pulsing out of it, saying something is
 * happening live, such as a bot using its computer. Needs the bot's colour
 * variables from an ancestor. Hidden from assistive technology: whatever holds
 * it says what is live.
 */
export function LiveDot() {
	return (
		<span aria-hidden className="relative flex size-2">
			<span className="absolute inline-flex size-full animate-ping rounded-full bg-bot-mono opacity-60 motion-reduce:animate-none" />
			<span className="relative inline-flex size-2 rounded-full bg-bot-mono" />
		</span>
	);
}
