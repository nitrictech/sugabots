import { Schema } from "effect";

/** The signed-in person's referral link, or `null` when the installation does not sign people up by referral. */
export const referralLinkSchema = Schema.Struct({ url: Schema.NullOr(Schema.String) });
export type ReferralLink = typeof referralLinkSchema.Type;

export const resetReferralLinkSchema = Schema.Struct({ url: Schema.String });
export type ResetReferralLink = typeof resetReferralLinkSchema.Type;
