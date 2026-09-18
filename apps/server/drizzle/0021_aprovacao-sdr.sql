ALTER TABLE "fluxo_sdr" ADD COLUMN "valor_acordado_centavos" integer;--> statement-breakpoint
ALTER TABLE "proposta_sdr" ADD COLUMN "origem" text DEFAULT 'agente' NOT NULL;