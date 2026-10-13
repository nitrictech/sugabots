import { X } from "lucide-react";
import { IconButton, type IconButtonProps } from "@/ui/icon-button.tsx";

/**
 * The X that closes a pane, sidebar, sheet or page: a filled circle, like the
 * ⋯ of a `MoreMenu` beside it. Pass `render` for a close that is a link or a
 * dialog's own close, so it still looks like this one.
 */
export function CloseButton({
	label = "Close",
	...props
}: Omit<IconButtonProps, "children" | "variant" | "size" | "label"> & { label?: string }) {
	return (
		<IconButton label={label} variant="round" {...props}>
			<X aria-hidden size={16} strokeWidth={2.2} />
		</IconButton>
	);
}
