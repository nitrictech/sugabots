import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { DetailTooltip } from "@/ui/tooltip.tsx";

/**
 * An (i) beside a few plain words, opening a longer explanation: where to
 * put what not everyone needs, such as what a technical term means.
 * `label` names it for a screen reader, such as "About allowed sites".
 */
export function InfoTip({
	label,
	title,
	children,
}: {
	label: string;
	title: ReactNode;
	children: ReactNode;
}) {
	return (
		<DetailTooltip title={title} description={children}>
			<button
				type="button"
				aria-label={label}
				className="focus-ring inline-grid shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground"
			>
				<Info aria-hidden size={14} />
			</button>
		</DetailTooltip>
	);
}
