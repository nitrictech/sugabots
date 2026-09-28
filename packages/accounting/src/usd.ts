import { Schema } from "effect";

/** An amount of money in US dollars, which is what models.dev and OpenRouter quote. */
export const Usd = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.brand("Usd"));
export type Usd = typeof Usd.Type;
