import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "cn";

/*
 * A menu that floats over the page, drawn as the design draws every floating
 * surface: a raised panel with the dialog's shadow, and rows the size of a
 * settings row's text.
 */

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
					className={cn(
						"z-50 max-h-(--available-height) min-w-[8rem] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-panel bg-panel p-1.5 text-foreground shadow-dialog outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
						className,
					)}
					{...props}
				/>
			</MenuPrimitive.Positioner>
		</MenuPrimitive.Portal>
	);
}

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
				"relative flex min-h-9 cursor-pointer select-none items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[14.5px] outline-hidden data-disabled:pointer-events-none data-highlighted:bg-hover data-disabled:text-disabled-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				"data-[variant=destructive]:text-destructive-text data-[variant=destructive]:data-highlighted:bg-destructive-hover",
				className,
			)}
			{...props}
		/>
	);
}

export { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger };
