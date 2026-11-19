import { Popover } from "@base-ui/react/popover";
import { type ReactElement, type ReactNode, useRef, useState } from "react";
import { EmojiPicker } from "@/ui/emoji-picker.tsx";
import { PopoverContent } from "@/ui/popover.tsx";

/**
 * `trigger`, a button that opens the emoji picker above it, lined up with its
 * start. Choosing an emoji gives it to `onSelect`, and once that takes it the
 * picker closes.
 */
export function EmojiPickerPopover({
	label,
	trigger,
	header,
	returnsFocus = true,
	onOpenChange,
	onSelect,
}: {
	/** Names the picker for assistive technology. */
	label: string;
	/** The button that opens it, such as an `IconButton`. */
	trigger: ReactElement;
	/** Over the picker, such as why some emoji can't be chosen. */
	header?: ReactNode;
	/**
	 * Whether closing after a choice gives the focus back to `trigger`. Off
	 * where taking the emoji has put the focus somewhere already, as the
	 * composer puts it back in the draft.
	 */
	returnsFocus?: boolean;
	onOpenChange?: (open: boolean) => void;
	/** Takes the emoji chosen, saying whether it was taken, which closes the picker. */
	onSelect: (emoji: string) => boolean;
}) {
	const [open, setOpen] = useState(false);
	const chose = useRef(false);
	function changeOpen(next: boolean) {
		if (next) chose.current = false;
		setOpen(next);
		onOpenChange?.(next);
	}
	return (
		<Popover.Root open={open} onOpenChange={changeOpen}>
			<Popover.Trigger render={trigger} />
			<PopoverContent
				side="top"
				aria-label={label}
				finalFocus={() => returnsFocus || !chose.current}
				className="overflow-hidden"
			>
				{header}
				<EmojiPicker
					onSelect={(emoji) => {
						if (!onSelect(emoji)) return;
						chose.current = true;
						changeOpen(false);
					}}
				/>
			</PopoverContent>
		</Popover.Root>
	);
}
