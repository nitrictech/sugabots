import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { cn } from "cn";
import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";

/*
 * A combobox: an input you can type into, a list that narrows as you do, and
 * chips inside the field when it holds several values.
 *
 * shadcn's `combobox` over Base UI, adapted to this design's tokens the way
 * `select.tsx` is. shadcn composes its field out of its own input-group
 * component; Base UI ships one (`Combobox.InputGroup`) that also anchors the
 * popup, so `ComboboxField` is that, styled like `Input`.
 */

const Combobox = ComboboxPrimitive.Root;

function ComboboxField({ className, ...props }: ComboboxPrimitive.InputGroup.Props) {
	return (
		<ComboboxPrimitive.InputGroup
			data-slot="combobox-field"
			className={cn(
				"focus-ring-within flex min-h-9 w-full cursor-text flex-wrap items-center gap-1.5 rounded-lg border border-input bg-raised px-2.5 py-1 text-base text-foreground transition-shadow",
				"data-disabled:cursor-default data-disabled:opacity-50 data-readonly:cursor-default",
				className,
			)}
			{...props}
		/>
	);
}

function ComboboxInput({ className, ...props }: ComboboxPrimitive.Input.Props) {
	return (
		<ComboboxPrimitive.Input
			data-slot="combobox-input"
			className={cn(
				"h-7 min-w-16 flex-1 bg-transparent p-0 text-base text-foreground outline-none placeholder:text-subtle-foreground disabled:cursor-default",
				className,
			)}
			{...props}
		/>
	);
}

function ComboboxTrigger({ className, children, ...props }: ComboboxPrimitive.Trigger.Props) {
	return (
		<ComboboxPrimitive.Trigger
			data-slot="combobox-trigger"
			className={cn(
				"focus-ring ml-auto grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-surface-accent hover:text-heading disabled:cursor-default [&_svg]:size-4",
				className,
			)}
			{...props}
		>
			{children}
			<ChevronDownIcon aria-hidden className="opacity-70" />
		</ComboboxPrimitive.Trigger>
	);
}

/**
 * Empties the field. Rendered only when there is something to clear, so the
 * control is not a permanently dead button beside the chevron.
 */
function ComboboxClear({ className, ...props }: ComboboxPrimitive.Clear.Props) {
	return (
		<ComboboxPrimitive.Clear
			data-slot="combobox-clear"
			className={cn(
				"focus-ring grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-surface-accent hover:text-heading disabled:cursor-default [&_svg]:size-4",
				className,
			)}
			{...props}
		>
			<XIcon aria-hidden className="opacity-70" />
		</ComboboxPrimitive.Clear>
	);
}

function ComboboxValue({ ...props }: ComboboxPrimitive.Value.Props) {
	return <ComboboxPrimitive.Value data-slot="combobox-value" {...props} />;
}

function ComboboxChips({ className, ...props }: ComboboxPrimitive.Chips.Props) {
	return (
		<ComboboxPrimitive.Chips
			data-slot="combobox-chips"
			className={cn("flex min-w-0 flex-1 flex-wrap items-center gap-1.5", className)}
			{...props}
		/>
	);
}

/** One held value. `removeLabel` names the cross; leave it out for a chip nobody can remove. */
function ComboboxChip({
	className,
	children,
	removeLabel,
	...props
}: ComboboxPrimitive.Chip.Props & { removeLabel?: string }) {
	return (
		<ComboboxPrimitive.Chip
			data-slot="combobox-chip"
			className={cn(
				"flex h-7 w-fit items-center gap-1 rounded-md bg-muted pl-2.5 font-medium text-md text-heading whitespace-nowrap",
				"focus-within:bg-primary-tint focus-within:text-primary-tint-foreground data-highlighted:bg-primary-tint data-highlighted:text-primary-tint-foreground",
				removeLabel === undefined ? "pr-2.5" : "pr-1",
				className,
			)}
			{...props}
		>
			{children}
			{removeLabel !== undefined && (
				<ComboboxPrimitive.ChipRemove
					data-slot="combobox-chip-remove"
					aria-label={removeLabel}
					className="focus-ring grid size-5 cursor-pointer place-items-center rounded-sm opacity-60 hover:bg-surface-accent hover:opacity-100 [&_svg]:size-3.5"
				>
					<XIcon aria-hidden />
				</ComboboxPrimitive.ChipRemove>
			)}
		</ComboboxPrimitive.Chip>
	);
}

function ComboboxContent({
	className,
	side = "bottom",
	sideOffset = 4,
	align = "start",
	alignOffset = 0,
	...props
}: ComboboxPrimitive.Popup.Props &
	Pick<ComboboxPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
	return (
		<ComboboxPrimitive.Portal>
			<ComboboxPrimitive.Positioner
				side={side}
				sideOffset={sideOffset}
				align={align}
				alignOffset={alignOffset}
				className="isolate z-50"
			>
				<ComboboxPrimitive.Popup
					data-slot="combobox-content"
					className={cn(
						"group/combobox-content relative isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-[8rem] max-w-(--available-width) origin-(--transform-origin) overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
						className,
					)}
					{...props}
				/>
			</ComboboxPrimitive.Positioner>
		</ComboboxPrimitive.Portal>
	);
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
	return (
		<ComboboxPrimitive.List
			data-slot="combobox-list"
			className={cn(
				"max-h-[min(18rem,calc(var(--available-height)---spacing(2)))] scroll-py-1 overflow-y-auto overscroll-contain p-1 data-empty:p-0",
				className,
			)}
			{...props}
		/>
	);
}

function ComboboxItem({ className, children, ...props }: ComboboxPrimitive.Item.Props) {
	return (
		<ComboboxPrimitive.Item
			data-slot="combobox-item"
			className={cn(
				"relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				className,
			)}
			{...props}
		>
			{children}
			<ComboboxPrimitive.ItemIndicator
				render={
					<span
						data-slot="combobox-item-indicator"
						className="pointer-events-none absolute right-2 flex size-3.5 items-center justify-center"
					/>
				}
			>
				<CheckIcon className="size-4" />
			</ComboboxPrimitive.ItemIndicator>
		</ComboboxPrimitive.Item>
	);
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
	return (
		<ComboboxPrimitive.Empty
			data-slot="combobox-empty"
			className={cn(
				"hidden w-full py-2 text-center text-sm text-muted-foreground group-data-empty/combobox-content:block",
				className,
			)}
			{...props}
		/>
	);
}

export {
	Combobox,
	ComboboxChip,
	ComboboxChips,
	ComboboxClear,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxField,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
	ComboboxTrigger,
	ComboboxValue,
};
