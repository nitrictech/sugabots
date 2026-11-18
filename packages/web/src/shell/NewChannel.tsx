import {
	CHANNEL_DESCRIPTION_MAX_LENGTH,
	CHANNEL_NAME_MAX_LENGTH,
	type Channel,
	type ChannelColor,
	type ChannelVisibility,
	leastUsedChannelColor,
	slugify,
} from "@sugabots/contracts";
import { type FormEvent, useState } from "react";
import { useChannels, useCreateChannel } from "@/lib/channels.ts";
import { failureMessage } from "@/lib/failure.ts";
import { ChannelColourPicker } from "@/shell/LookPicker.tsx";
import { ChannelInitial } from "@/shell/SidebarChannel.tsx";
import { Alert } from "@/ui/alert.tsx";
import {
	DialogForm,
	DialogFormBody,
	DialogFormFooter,
	DialogFormHeader,
} from "@/ui/dialog-form.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import { SettingsControlRow, SettingsFieldRow, SettingsGroup } from "@/ui/settings-page.tsx";

/**
 * Making a channel: a name, what it's for, whether anyone may join it, and a
 * colour, under the channel as the sidebar will show it. Its people and bots
 * come after.
 */
export function NewChannelDialog({
	onCreated,
}: {
	onCreated: (channel: Channel) => Promise<void>;
}) {
	const [name, setName] = useState("");
	const { data: channels } = useChannels();
	const [chosenColor, setChosenColor] = useState<ChannelColor>();
	const [description, setDescription] = useState("");
	const [visibility, setVisibility] = useState<ChannelVisibility>("public");
	// Until somebody picks one, the colour the workspace's channels have least of,
	// so channels made without a second thought still look unlike each other.
	const color =
		chosenColor ?? leastUsedChannelColor(channels?.map((channel) => channel.color) ?? []);
	const create = useCreateChannel();
	// The API makes the channel's address from its name, so a name with nothing to make one from is no name.
	const usable = slugify(name) !== "";

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!usable) return;
		try {
			const channel = await create.mutateAsync({
				name,
				color,
				visibility,
				description: description.trim() || null,
			});
			if (!channel) throw new Error("channel creation returned no channel");
			await onCreated(channel);
		} catch {
			return;
		}
	}

	return (
		<DialogForm onSubmit={submit}>
			<DialogFormHeader title="New channel" />

			<DialogFormBody gap="compact">
				<div className="flex justify-center pt-1 pb-2">
					{/* The channel as the sidebar will show it: its initial, once named, on its colour. */}
					<ChannelInitial
						channel={{ name, color }}
						size="lg"
						className="size-16 rounded-2xl text-2xl"
					/>
				</div>
				<SettingsGroup note="You can add people and bots next.">
					<SettingsFieldRow
						label="Name"
						value={name}
						onChange={setName}
						placeholder="e.g. Support"
						maxLength={CHANNEL_NAME_MAX_LENGTH}
					/>
					<SettingsFieldRow
						label="Description"
						value={description}
						onChange={setDescription}
						placeholder="What it's for"
						maxLength={CHANNEL_DESCRIPTION_MAX_LENGTH}
					/>
					<SettingsControlRow label="Who can join">
						<SegmentedControl
							label="Who can join"
							options={[
								{ value: "public", label: "Anyone" },
								{ value: "private", label: "Invited only" },
							]}
							value={visibility}
							onChange={setVisibility}
						/>
					</SettingsControlRow>
					<SettingsControlRow label="Colour">
						<ChannelColourPicker value={color} onChange={setChosenColor} />
					</SettingsControlRow>
				</SettingsGroup>

				{create.error && (
					<Alert>
						{failureMessage(create.error, {
							Conflict: "A channel with that name already exists. Try another name.",
							Forbidden: "You can't make a channel in this workspace.",
						})}
					</Alert>
				)}
			</DialogFormBody>
			<DialogFormFooter action="Create" actionDisabled={!usable || create.isPending} />
		</DialogForm>
	);
}
