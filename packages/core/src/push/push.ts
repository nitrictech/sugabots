export * as Push from "./push.ts";

import type { NotificationContent, PushDevice, PushService } from "@sugabots/contracts";
import { Config, Context, Data, Effect, Layer, Option } from "effect";
import { Installation } from "../installation/installation.ts";
import { fromApns } from "./implementations/apns.ts";
import { fromConsole } from "./implementations/console.ts";

/** Notifications sent to the app on a person's phone, which show while the app is closed. */
export interface Interface {
	/**
	 * Whether this installation can push to phones of `service`: it holds that
	 * service's key for the app, or, outside production, prints the pushes.
	 */
	readonly reaches: (service: PushService) => boolean;
	/**
	 * Shows `notification` on `device`, through its platform's push service.
	 * Does nothing for a service this installation does not reach.
	 */
	readonly send: (
		device: PushDevice,
		notification: NotificationContent,
	) => Effect.Effect<void, Failure>;
	/**
	 * Asks `device`'s push service whether it will deliver to the token, with
	 * a silent push that shows nothing, so a made-up or mismatched token is
	 * caught before it is kept.
	 */
	readonly check: (device: PushDevice) => Effect.Effect<void, Failure>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Push") {}

/**
 * A sender for each push service whose key is given, `APNS_KEY_ID` for
 * Apple's, so one installation can notify iPhones and Android phones alike.
 * Outside production, a service without one prints its pushes instead; in
 * production it is not reached, and phones on it are not kept.
 */
export const make = Effect.gen(function* () {
	const installation = yield* Installation.Service;
	const withoutKey = installation.isProduction ? undefined : fromConsole;
	const apnsKeyId = yield* Config.option(Config.String("APNS_KEY_ID"));
	const senders: Senders = {
		apns: Option.isSome(apnsKeyId)
			? yield* fromApns(yield* apnsConfig(apnsKeyId.value))
			: withoutKey,
		// Google's sender joins with the Android app, which is not built yet.
		fcm: withoutKey,
	};
	return {
		reaches: (service) => senders[service] !== undefined,
		send: (device, notification) =>
			through(senders, device, (sender, reached) => sender.send(reached, notification)),
		check: (device) => through(senders, device, (sender, reached) => sender.check(reached)),
	} satisfies Interface;
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps;

/** The phones one push service reaches. */
export type DeviceOf<Of extends PushService> = Extract<PushDevice, { service: Of }>;

/** Sends to the phones of one push service. */
export interface Sender<Of extends PushService> {
	readonly send: (
		device: DeviceOf<Of>,
		notification: NotificationContent,
	) => Effect.Effect<void, Failure>;
	readonly check: (device: DeviceOf<Of>) => Effect.Effect<void, Failure>;
}

export type Failure = DeviceGone | TokenRefused | DeliveryFailed;

/** The app was removed from the phone, so its token will never work again. */
export class DeviceGone extends Data.TaggedError("PushDeviceGone")<{
	reason: string;
}> {}

/**
 * The service refused the token as malformed, for another app, or for its
 * other environment. For a token a phone really gave, that points at this
 * installation's settings or the build, not the phone.
 */
export class TokenRefused extends Data.TaggedError("PushTokenRefused")<{
	reason: string;
}> {}

/** The push could not be handed over this time: the service was unreachable, or refused this installation. */
export class DeliveryFailed extends Data.TaggedError("PushDeliveryFailed")<{
	service: PushService;
	cause: unknown;
}> {}

export class InvalidConfig extends Data.TaggedError("InvalidPushConfig")<{
	message: string;
}> {}

type Senders = { readonly [Of in PushService]: Sender<Of> | undefined };

/** Runs `use` with `device`'s own service's sender, or does nothing where none reaches it. */
function through(
	senders: Senders,
	device: PushDevice,
	use: <Of extends PushService>(
		sender: Sender<Of>,
		device: DeviceOf<Of>,
	) => Effect.Effect<void, Failure>,
): Effect.Effect<void, Failure> {
	switch (device.service) {
		case "apns":
			return senders.apns ? use(senders.apns, device) : Effect.void;
		case "fcm":
			return senders.fcm ? use(senders.fcm, device) : Effect.void;
	}
}

/** The bundle identifier of the app on the App Store, which Apple calls the topic. */
const APP_BUNDLE_ID = "ai.sugabots.app";

/**
 * Apple's push key for the app: `APNS_KEY_ID` and `APNS_TEAM_ID` from the
 * developer account, `APNS_PRIVATE_KEY`, the `.p8` file's contents, with its
 * line breaks or written as `\n`, and `APNS_TOPIC`, the app's bundle identifier.
 */
const apnsConfig = (keyId: string) =>
	Effect.gen(function* () {
		return {
			keyId,
			teamId: yield* Config.String("APNS_TEAM_ID"),
			privateKey: yield* Config.Redacted("APNS_PRIVATE_KEY"),
			topic: yield* Config.String("APNS_TOPIC").pipe(Config.withDefault(APP_BUNDLE_ID)),
		};
	});
