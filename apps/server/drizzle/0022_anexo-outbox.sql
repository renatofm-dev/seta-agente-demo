ALTER TABLE "mensagem" ADD COLUMN "anexo_nome" text;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "anexo" jsonb;