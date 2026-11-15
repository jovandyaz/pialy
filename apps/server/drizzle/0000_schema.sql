CREATE SEQUENCE "public"."booking_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9999999 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer DEFAULT nextval('booking_number_seq') NOT NULL,
	"token" text NOT NULL,
	"business_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"intent_id" uuid,
	"slot_start" timestamp with time zone NOT NULL,
	"during" "tstzrange" NOT NULL,
	"status" text DEFAULT 'holding' NOT NULL,
	"customer_name" text,
	"phone_last4" char(4) NOT NULL,
	"phone_hash" text NOT NULL,
	"late" boolean DEFAULT false NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"checked_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_number_unique" UNIQUE("number"),
	CONSTRAINT "bookings_token_unique" UNIQUE("token"),
	CONSTRAINT "bookings_status_check" CHECK ("bookings"."status" IN ('holding','confirmed','checked_in','expired','canceled'))
);
--> statement-breakpoint
CREATE TABLE "business" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"service_name" text NOT NULL,
	"service_minutes" integer NOT NULL,
	"deposit_minor" integer NOT NULL,
	"currency" text DEFAULT 'MXN' NOT NULL,
	"slot_minutes" integer NOT NULL,
	"timezone" text DEFAULT 'America/Mexico_City' NOT NULL,
	"hours" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"booking_id" uuid,
	"payload" jsonb NOT NULL,
	"note" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flags_kind_check" CHECK ("flags"."kind" IN ('unmatched_payment','refund_due','amount_mismatch'))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text NOT NULL,
	"scope" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_code" integer,
	"response_body" jsonb,
	"recovery_point" text,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_key_scope_pk" PRIMARY KEY("key","scope")
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"provider_tx_id" text,
	"provider_qr_id" text,
	"codi_id" text,
	"status" text DEFAULT 'awaiting' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_mode_check" CHECK ("payment_attempts"."mode" IN ('push','qr')),
	CONSTRAINT "payment_attempts_status_check" CHECK ("payment_attempts"."status" IN ('awaiting','succeeded','expired','failed'))
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid,
	"intent_id" uuid,
	"provider_tx_id" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text DEFAULT 'MXN' NOT NULL,
	"tracking_key" text,
	"late" boolean DEFAULT false NOT NULL,
	"raw" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_events_provider_tx_id_unique" UNIQUE("provider_tx_id")
);
--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text DEFAULT 'MXN' NOT NULL,
	"status" text DEFAULT 'requires_payment' NOT NULL,
	"succeeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intents_reference_unique" UNIQUE("reference"),
	CONSTRAINT "payment_intents_status_check" CHECK ("payment_intents"."status" IN ('requires_payment','processing','succeeded','expired','canceled')),
	CONSTRAINT "payment_intents_amount_check" CHECK ("payment_intents"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_inbox" (
	"webhook_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"outcome" text
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_phone_hash_idx" ON "bookings" USING btree ("phone_hash");--> statement-breakpoint
CREATE INDEX "bookings_status_hold_expires_idx" ON "bookings" USING btree ("status","hold_expires_at");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox" USING btree ("created_at") WHERE "outbox"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "payment_attempts_intent_idx" ON "payment_attempts" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "payment_attempts_provider_tx_idx" ON "payment_attempts" USING btree ("provider_tx_id");--> statement-breakpoint
CREATE INDEX "payment_attempts_provider_qr_idx" ON "payment_attempts" USING btree ("provider_qr_id");