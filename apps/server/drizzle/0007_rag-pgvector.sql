-- editada à mão (padrão da 0004): extensão + coluna gerada tsvector + GIN,
-- que o drizzle-kit não expressa. pgvector já vem no init de volume novo, mas
-- volumes anteriores à 008 precisam do CREATE EXTENSION aqui.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "chunk" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ns" text NOT NULL,
	"documento_id" uuid,
	"fonte" text NOT NULL,
	"titulo" text,
	"seq" integer DEFAULT 0 NOT NULL,
	"texto" text NOT NULL,
	"metadados" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"embedding" vector,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documento" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ns" text NOT NULL,
	"fonte" text NOT NULL,
	"titulo" text NOT NULL,
	"hash" text NOT NULL,
	"versao" integer DEFAULT 1 NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documento_ns_fonte_unique" UNIQUE("ns","fonte")
);
--> statement-breakpoint
ALTER TABLE "chunk" ADD CONSTRAINT "chunk_documento_id_documento_id_fk" FOREIGN KEY ("documento_id") REFERENCES "public"."documento"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunk_ns_idx" ON "chunk" USING btree ("ns");--> statement-breakpoint
CREATE INDEX "chunk_documento_idx" ON "chunk" USING btree ("documento_id");--> statement-breakpoint
ALTER TABLE "skill_versao" DROP COLUMN "embedding";--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', "texto")) STORED;--> statement-breakpoint
CREATE INDEX "chunk_tsv_gin" ON "chunk" USING gin ("tsv");