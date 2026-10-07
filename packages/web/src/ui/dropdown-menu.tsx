import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "cn";
import { Check } from "lucide-react";

/*
 * A menu that floats over the page, drawn as the design draws every popover: a
 * raised panel edged in a strong hairline with a soft shadow, and rows the size
 * of a settings row's text. It opens from a trigger, or as a context menu where the
 * pointer is right-clicked; both hold the same items.
 */

const popupClassName =
	"z-50 max-h-(--available-height) min-w-[8rem] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border border-border-strong bg-panel p-1 text-foreground shadow-popover outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95";

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
	return <MenuPrimitive.Root {...props} />;
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
	return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
	align = "start",
	alignOffset = 0,
	side = "bottom",
	sideOffset = 6,
	className,
	...props
}: MenuPrimitive.Popup.Props &
	Pick<MenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
	return (
		<MenuPrimitive.Portal>
			<MenuPrimitive.Positioner
				className="isolate z-50 outline-none"
				align={align}
				alignOffset={alignOffset}
				side={side}
				sideOffset={sideOffset}
			>
				<MenuPrimitive.Popup
					data-slot="dropdown-menu-content"
					className={cn(popupClassName, className)}
					{...props}
				/>
			</MenuPrimitive.Positioner>
		</MenuPrimitive.Portal>
	);
}

const itemClassName =
	"relative flex min-h-9 cursor-pointer select-none items-center gap-2.5 rounded-tail px-2.5 py-2 text-base outline-hidden data-disabled:pointer-events-none data-highlighted:bg-chip data-disabled:text-disabled-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

function DropdownMenuItem({
	className,
	variant = "default",
	...props
}: MenuPrimitive.Item.Props & {
	variant?: "default" | "destructive";
}) {
	return (
		<MenuPrimitive.Item
			data-slot="dropdown-menu-item"
			data-variant={variant}
			className={cn(
				itemClassName,
				"data-[variant=destructive]:text-destructive-text data-[variant=destructive]:data-highlighted:bg-destructive-hover",
				className,
			)}
			{...props}
		/>
	);
}

/** A set of items of which one is chosen, such as a setting's values. */
function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
	return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

/** One of a radio group's items, ticked at its end while it is the chosen one. */
function DropdownMenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
	return (
		<MenuPrimitive.RadioItem
			data-slot="dropdown-menu-radio-item"
			className={cn(itemClassName, "pr-8", className)}
			{...props}
		>
			{children}
			<MenuPrimitive.RadioItemIndicator className="absolute right-2.5 text-link">
				<Check aria-hidden />
			</MenuPrimitive.RadioItemIndicator>
		</MenuPrimitive.RadioItem>
	);
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
	return (
		<MenuPrimitive.Separator
			data-slot="dropdown-menu-separator"
			className={cn("-mx-1 my-1 h-px bg-border", className)}
			{...props}
		/>
	);
}

function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
	return <ContextMenuPrimitive.Root {...props} />;
}

/** The area that opens the menu when right-clicked, or long-pressed on a touch screen. */
function ContextMenuTrigger({ ...props }: ContextMenuPrimitive.Trigger.Props) {
	return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

function ContextMenuContent({ className, ...props }: ContextMenuPrimitive.Popup.Props) {
	return (
		<ContextMenuPrimitive.Portal>
			<ContextMenuPrimitive.Positioner className="isolate z-50 outline-none">
				<ContextMenuPrimitive.Popup
					data-slot="context-menu-content"
					className={cn(popupClassName, className)}
					{...props}
				/>
			</ContextMenuPrimitive.Positioner>
		</ContextMenuPrimitive.Portal>
	);
}

export {
	ContextMenu,
	ContextMenuContent,
	ContextMenuTrigger,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
};
