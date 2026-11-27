import { Repeat } from "lucide-react";
import { useState } from "react";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group.tsx";
import {
	PageBackLink,
	SettingsDanger,
	SettingsGroup,
	SettingsPage,
	SettingsRadioList,
	SettingsRow,
	SettingsRowAlert,
	SettingsRowIcon,
	SettingsValue,
} from "./settings-page.tsx";
import { Switch } from "./switch.tsx";

function Theme() {
	const [theme, setTheme] = useState<"dark" | "light" | "system">("dark");
	return (
		<RadioGroup aria-label="Theme" value={theme} onValueChange={setTheme}>
			{[
				{ value: "dark", label: "Dark" },
				{ value: "light", label: "Light" },
				{ value: "system", label: "System" },
			].map((option) => (
				<RadioGroupItem key={option.value} value={option.value}>
					{option.label}
				</RadioGroupItem>
			))}
		</RadioGroup>
	);
}

function AdvancedSwitch() {
	const [on, setOn] = useState(true);
	return <Switch aria-label="Advanced" checked={on} onCheckedChange={setOn} />;
}

const meta = preview.meta({
	title: "Patterns/SettingsPage",
	component: SettingsPage,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: { children: null },
});

/** Hero is a page about one thing, such as the workspace or you: its picture first, then its groups. */
export const Hero = meta.story({
	render: () => (
		<SettingsPage
			hero={
				<span className="grid size-22 place-items-center rounded-3xl bg-foreground font-extrabold text-4xl text-background">
					N
				</span>
			}
			title="Nitric"
			description="4 members"
		>
			<SettingsGroup label="Workspace">
				<SettingsRow label="Name" trailing={<SettingsValue>Nitric</SettingsValue>} />
				<SettingsRow label="Your access" trailing={<SettingsValue>Admin</SettingsValue>} />
			</SettingsGroup>
			<SettingsGroup label="Appearance">
				<SettingsRow label="Theme" trailing={<Theme />} />
			</SettingsGroup>
			<SettingsDanger
				label="Delete workspace"
				description="Removes every project, bot and chat in Nitric."
				action="Delete"
				onClick={fn()}
			/>
		</SettingsPage>
	),
});

const opened = fn();

/** Listing is a page of things to open, each row a way in, with a note under its group. */
export const Listing = meta.story({
	render: () => (
		<SettingsPage
			title="Automations"
			description="What your bots do on a schedule, or when called."
		>
			<SettingsGroup
				label="Growth Desk"
				note="Each automation posts into its own chat when it runs."
			>
				<SettingsRow
					icon={
						<SettingsRowIcon>
							<Repeat size={15} strokeWidth={2.2} />
						</SettingsRowIcon>
					}
					label="Overnight outbound"
					sub="Every day at 6:00 am"
					chevron
					onClick={opened}
				/>
				<SettingsRow
					label="Advanced"
					sub="Choose a provider for web search"
					trailing={<AdvancedSwitch />}
				/>
			</SettingsGroup>
		</SettingsPage>
	),
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /Overnight outbound/ }));
		await expect(opened).toHaveBeenCalled();
	},
});

/**
 * A page opened from another, with its Back, beside the page it came from: on
 * a wide screen the Back sits above the title, so both titles are level and
 * moving between the pages doesn't move the title.
 */
export const OpenedFromAnother = meta.story({
	globals: { viewport: { value: "desktop", isRotated: false } },
	render: () => (
		<div className="flex">
			<div className="flex-1">
				<SettingsPage title="Models" description="What your bots think with.">
					{null}
				</SettingsPage>
			</div>
			<div className="flex-1">
				<SettingsPage
					back={<PageBackLink label="Models" render={<button type="button" />} />}
					backOnWide
					title="Default for new bots"
					description="The model a new bot starts with."
				>
					{null}
				</SettingsPage>
			</div>
		</div>
	),
	play: async ({ canvas }) => {
		const page = canvas.getByRole("heading", { name: "Models" }).getBoundingClientRect();
		const opened = canvas
			.getByRole("heading", { name: "Default for new bots" })
			.getBoundingClientRect();
		await expect(opened.top).toBe(page.top);
	},
});

const providers = [
	{
		id: "e2b",
		name: "E2B",
		description: "Online computers, made from an image.",
		badge: "In use",
	},
	{ id: "daytona", name: "Daytona", description: "Workspaces on Daytona's cloud." },
	{ id: "opensandbox", name: "OpenSandbox", description: "Containers on a server you run." },
] as const;

function ProviderList({ onChoose }: { onChoose: (id: string) => void }) {
	const [chosen, setChosen] = useState<(typeof providers)[number]["id"]>("e2b");
	return (
		<SettingsPage title="Computers">
			<SettingsRadioList
				legend="Provider"
				options={providers}
				chosen={chosen}
				disabled={false}
				onChoose={(id) => {
					setChosen(id);
					onChoose(id);
				}}
			/>
		</SettingsPage>
	);
}

/** RadioList picks one of several, each with its initial, name and what it is; one may carry a word beside its name. */
export const RadioList = meta.story({
	render: () => <ProviderList onChoose={fn()} />,
	play: async ({ canvas, userEvent }) => {
		await expect(canvas.getByText("In use")).toBeVisible();
		await expect(canvas.getByRole("radio", { name: /E2B/ })).toBeChecked();
		await userEvent.click(canvas.getByText("Daytona"));
		await expect(canvas.getByRole("radio", { name: /Daytona/ })).toBeChecked();
	},
});

/** RowAlert says why something failed as a row of the group, among its rows. */
export const RowAlert = meta.story({
	render: () => (
		<SettingsPage title="Members">
			<SettingsGroup label="Role">
				<SettingsRow label="Role" trailing={<SettingsValue>Editor</SettingsValue>} />
				<SettingsRowAlert>The role could not be changed. Try again.</SettingsRowAlert>
			</SettingsGroup>
		</SettingsPage>
	),
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("alert")).toHaveTextContent("The role could not be changed.");
	},
});
