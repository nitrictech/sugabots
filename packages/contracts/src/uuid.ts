import { Schema } from "effect";

export const uuidSchema = Schema.String.check(Schema.isUUID());
