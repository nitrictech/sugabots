import { useRender } from "@base-ui/react/use-render";
import { cn } from "cn";
import type { ReactNode } from "react";

const LOOKS = {
	/** Among other rows in a list, shaded by `className` as it is hovered or selected. */
	list: {
		row: "gap-3 rounded-lg p-2",
		text: "leading-snug",
		title: "text-xs",
	},
	/** On its own among a message's words, framed as a file a bot writes is. */
	card: {
		row: "gap-2.5 rounded-bubble border border-border bg-card py-2 pr-3 pl-2.5",
		text: "gap-px",
		title: "text-sm",
	},
} as const;

/**
 * A file, or a link standing for one, as one row: `icon` (an `IconTile`), its
 * title over a line about it, each cut short to fit, and `trailing` at its end.
 * `render` makes the row a link or another element; it is a `div` without.
 */
export function FileRow({
	icon,
	title,
	subtitle,
	trailing,
	look,
	className,
	render,
}: {
	icon: ReactNode;
	title: ReactNode;
	subtitle: ReactNode;
	trailing?: ReactNode;
	look: keyof typeof LOOKS;
	className?: string;
	render?: useRender.RenderProp;
}) {
	const styles = LOOKS[look];
	return useRender({
		render,
		defaultTagName: "div",
		props: {
			className: cn("flex items-center", styles.row, className),
			children: (
				<>
					{icon}
					<span className={cn("flex min-w-0 flex-1 flex-col", styles.text)}>
						<span className={cn("truncate font-medium text-foreground", styles.title)}>
							{title}
						</span>
						<span className="truncate text-subtle-foreground text-xs">{subtitle}</span>
					</span>
					{trailing}
				</>
			),
		},
	});
}
