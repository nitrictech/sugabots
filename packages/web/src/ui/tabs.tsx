import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "cn";

/*
 * A row of tabs, each showing its own panel: Base UI's Tabs, which move
 * between tabs with the arrow keys. A tab is drawn as a word, the chosen one
 * in the foreground colour and the others muted until hovered.
 */

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
	return (
		<TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col", className)} {...props} />
	);
}

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
	return (
		<TabsPrimitive.List data-slot="tabs-list" className={cn("flex gap-4", className)} {...props} />
	);
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
	return (
		<TabsPrimitive.Tab
			data-slot="tabs-trigger"
			className={cn(
				"focus-ring rounded-sm font-semibold text-muted-foreground text-sm transition-colors hover:text-foreground data-active:text-foreground",
				className,
			)}
			{...props}
		/>
	);
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
	return (
		<TabsPrimitive.Panel
			data-slot="tabs-content"
			className={cn("outline-none", className)}
			{...props}
		/>
	);
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
