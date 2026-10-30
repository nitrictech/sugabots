import { cn } from "cn";
import { X } from "lucide-react";
import { FLOATING_ON_PHONE, IconButton, type IconButtonProps } from "@/ui/icon-button.tsx";

/**
 * The X that closes a pane, sidebar, sheet or page: a filled circle, like the
 * ⋯ of a `MoreMenu` beside it, and round on glass on a phone, as its other
 * controls are. Pass `render` for a close that is a link or a dialog's own
 * close, so it still looks like this one.
 */
export function CloseButton({
	label = "Close",
	className,
	...props
}: Omit<IconButtonProps, "children" | "variant" | "size" | "label"> & { label?: string }) {
	return (
		<IconButton
			label={label}
			variant="round"
			className={cn(FLOATING_ON_PHONE, className)}
			{...props}
		>
			<X aria-hidden size={16} strokeWidth={2.2} />
		</IconButton>
	);
}
