import { cn } from "cn";
import { extensionOf } from "@/lib/file-looks.ts";

/** How many characters before the extension stay when a name is cut short. */
const MIDDLE_TRUNCATION_KEPT = 3;

/** Shows `text` on one line, cutting from its middle when it is too long, so its end and extension stay. */
export function MiddleTruncated({ text, className }: { text: string; className?: string }) {
	const extensionLength = extensionOf(text).length;
	const tailLength = Math.min(Math.ceil(text.length / 2), extensionLength + MIDDLE_TRUNCATION_KEPT);
	return (
		<span className={cn("flex min-w-0 whitespace-nowrap", className)}>
			<span className="truncate">{text.slice(0, text.length - tailLength)}</span>
			<span className="shrink-0">{text.slice(text.length - tailLength)}</span>
		</span>
	);
}
