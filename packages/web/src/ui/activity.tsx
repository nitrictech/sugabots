import { Collapsible } from "@base-ui/react/collapsible";
import { cn } from "cn";
import { ChevronRightIcon } from "lucide-react";
import type * as React from "react";

/*
 * A turn's activity: the steps and tool calls shown while it works, each an
 * `ActivityLine`, and those that open onto more in an `ActivityCollapsible`.
 */

function Activity({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="activity"
			className={cn(
				"flex w-full min-w-0 flex-col gap-2 *:has-[>[data-slot=activity-line]]:flex *:has-[>[data-slot=activity-line]]:w-fit *:has-[>[data-slot=activity-line]]:max-w-full *:has-[>[data-slot=activity-line]]:min-w-0 *:has-[>[data-slot=activity-line]]:rounded-md *:has-[>[data-slot=activity-line]]:text-left *:has-[>[data-slot=activity-line]]:focus-ring",
				className,
			)}
			{...props}
		/>
	);
}

function ActivityLine({
	className,
	status,
	...props
}: React.ComponentProps<"span"> & {
	status?: "running" | "error";
}) {
	return (
		<span
			data-slot="activity-line"
			data-status={status}
			className={cn(
				"flex w-fit max-w-full min-w-0 items-center gap-2 text-sm text-muted-foreground transition-colors in-[a,button]:cursor-pointer in-[a:hover,button:hover]:text-foreground in-[a:focus-visible,button:focus-visible]:text-foreground data-[status=error]:text-destructive-text data-[status=error]:in-[a:hover,button:hover]:text-destructive-text data-[status=error]:in-[a:focus-visible,button:focus-visible]:text-destructive-text data-[status=running]:*:data-[slot=activity-title]:shimmer",
				className,
			)}
			{...props}
		/>
	);
}

function ActivityIcon({ className, ...props }: React.ComponentProps<"span">) {
	return (
		<span
			data-slot="activity-icon"
			aria-hidden="true"
			className={cn(
				"flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [[data-slot=activity-title]~&]:-ml-1",
				className,
			)}
			{...props}
		/>
	);
}

function ActivityTitle({ className, ...props }: React.ComponentProps<"span">) {
	return (
		<span
			data-slot="activity-title"
			className={cn("min-w-0 truncate motion-reduce:shimmer-none", className)}
			{...props}
		/>
	);
}

function ActivityDescription({ className, ...props }: React.ComponentProps<"span">) {
	return (
		<span
			data-slot="activity-description"
			className={cn("shrink-0 text-subtle-foreground tabular-nums", className)}
			{...props}
		/>
	);
}

function ActivityCollapsible({
	className,
	...props
}: Omit<Collapsible.Root.Props, "open"> &
	(
		| { open?: undefined }
		| {
				open: boolean;
				onOpenChange: NonNullable<Collapsible.Root.Props["onOpenChange"]>;
		  }
	)) {
	return (
		<Collapsible.Root
			data-slot="activity-collapsible"
			className={cn("flex w-full min-w-0 flex-col", className)}
			{...props}
		/>
	);
}

function ActivityCollapsibleTrigger({ className, children, ...props }: Collapsible.Trigger.Props) {
	return (
		<Collapsible.Trigger
			data-slot="activity-collapsible-trigger"
			className={cn(
				"group/activity-collapsible-trigger flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-md text-left text-muted-foreground focus-ring transition-colors hover:text-foreground has-[[data-status=error]]:text-destructive-text",
				className,
			)}
			{...props}
		>
			{children}
			<ActivityIcon className="transition-transform group-aria-expanded/activity-collapsible-trigger:rotate-90">
				<ChevronRightIcon />
			</ActivityIcon>
		</Collapsible.Trigger>
	);
}

function ActivityCollapsibleContent({ className, children, ...props }: Collapsible.Panel.Props) {
	return (
		<Collapsible.Panel
			data-slot="activity-collapsible-content"
			className="h-(--collapsible-panel-height) min-w-0 overflow-hidden transition-height duration-200 data-ending-style:h-0 data-starting-style:h-0"
			{...props}
		>
			<div
				data-slot="activity-collapsible-content-inner"
				className={cn(
					"mt-2 mb-1 ml-1.5 min-w-0 border-l pr-1 pl-4 leading-relaxed wrap-break-word text-muted-foreground",
					className,
				)}
			>
				{children}
			</div>
		</Collapsible.Panel>
	);
}

export {
	Activity,
	ActivityCollapsible,
	ActivityCollapsibleContent,
	ActivityCollapsibleTrigger,
	ActivityDescription,
	ActivityIcon,
	ActivityLine,
	ActivityTitle,
};
