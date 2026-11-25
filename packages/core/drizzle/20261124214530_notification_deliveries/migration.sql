CREATE TABLE "notification_delivery" (
	"chat_id" uuid,
	"delivery_id" text,
	"member_id" uuid,
	"notification" jsonb NOT NULL,
	CONSTRAINT "notification_delivery_pkey" PRIMARY KEY("chat_id","delivery_id","member_id")
);
--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_chat_id_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chat"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_member_id_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "member"("id") ON DELETE CASCADE;