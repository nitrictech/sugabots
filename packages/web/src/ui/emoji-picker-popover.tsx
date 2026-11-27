import { Popover } from "@base-ui/react/popover";
import { type ReactElement, type ReactNode, useState } from "react";
import { EmojiPicker } from "@/ui/emoji-picker.tsx";
import { PopoverContent } from "@/ui/popover.tsx";

/**
 * `trigger`, a button that opens the emoji picker above it, lined up with its
 * start. Choosing an emoji gives it to `onSelect`, and once that takes it the
 * picker closes, giving the focus back to `trigger`.
 */
export function EmojiPickerPopover({
	label,
	trigger,
	header,
	onOpenChange,
	onSelect,
}: {
	/** Names the picker for assistive technology. */
	label: string;
	/** The button that opens it, such as an `IconButton`. */
	trigger: ReactElement;
	/** Over the picker, such as why some emoji can't be chosen. */
	header?: ReactNode;
	onOpenChange?: (open: boolean) => void;
	/** Takes the emoji chosen, saying whether it was taken, which closes the picker. */
	onSelect: (emoji: string) => boolean;
}) {
	const [open, setOpen] = useState(false);
	function changeOpen(next: boolean) {
		setOpen(next);
		onOpenChange?.(next);
	}
	return (
		<Popover.Root open={open} onOpenChange={changeOpen}>
			<Popover.Trigger render={trigger} />
			<PopoverContent side="top" aria-label={label} className="overflow-hidden">
				{header}
				<EmojiPicker
					onSelect={(emoji) => {
						if (onSelect(emoji)) changeOpen(false);
					}}
				/>
			</PopoverContent>
		</Popover.Root>
	);
}
