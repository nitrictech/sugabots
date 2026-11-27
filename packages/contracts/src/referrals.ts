import { Schema } from "effect";

/** The current user's referral link, or `null` when the server does not sign members up by referral. */
export const referralLinkSchema = Schema.Struct({ url: Schema.NullOr(Schema.String) });

export const resetReferralLinkSchema = Schema.Struct({ url: Schema.String });
