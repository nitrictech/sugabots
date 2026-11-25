UPDATE "connector" SET "oauth_state" = NULL WHERE "oauth_state" IS NOT NULL;
