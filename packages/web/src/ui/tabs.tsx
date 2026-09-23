import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "cn";

/*
 * Tabs, as the agent page draws them: plain words in a row, one hairline
 * under the row, and the chosen word underlined in the accent. Base UI does
 * the roving focus and the `tab`/`tabpanel` roles.
 */

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
	return (
		<TabsPrimitive.List
			className={cn("flex gap-5 overflow-x-auto border-b border-border-subtle sm:gap-6", className)}
			{...props}
		/>
	);
}

export function Tab({ className, ...props }: TabsPrimitive.Tab.Props) {
	return (
		<TabsPrimitive.Tab
			className={cn(
				"focus-ring -mb-px cursor-pointer border-b-2 border-transparent pb-2.5 font-medium text-base text-muted-foreground transition-colors hover:text-heading",
				"data-active:border-primary data-active:text-heading",
				className,
			)}
			{...props}
		/>
	);
}

export function TabPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
	return <TabsPrimitive.Panel className={cn("focus-ring pt-6", className)} {...props} />;
}
