CREATE TABLE "venda" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversa_id" uuid NOT NULL,
	"lead_id" uuid,
	"proposta_id" uuid,
	"cobranca_id" uuid,
	"status" text NOT NULL,
	"comprador" jsonb NOT NULL,
	"cota_id" text NOT NULL,
	"cota_codigo" text NOT NULL,
	"id_produto" integer NOT NULL,
	"valor_centavos" integer NOT NULL,
	"sinal_centavos" integer NOT NULL,
	"erp_pessoa_id" text,
	"erp_casal_id" text,
	"erp_contrato_id" text,
	"motivo" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cobranca" ADD COLUMN "origem" text DEFAULT 'contrato' NOT NULL;--> statement-breakpoint
ALTER TABLE "cobranca" ADD COLUMN "proposta_id" uuid;--> statement-breakpoint
ALTER TABLE "fluxo_sdr" ADD COLUMN "comprador" jsonb;--> statement-breakpoint
ALTER TABLE "venda" ADD CONSTRAINT "venda_conversa_id_conversa_id_fk" FOREIGN KEY ("conversa_id") REFERENCES "public"."conversa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venda" ADD CONSTRAINT "venda_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venda" ADD CONSTRAINT "venda_proposta_id_proposta_sdr_id_fk" FOREIGN KEY ("proposta_id") REFERENCES "public"."proposta_sdr"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venda" ADD CONSTRAINT "venda_cobranca_id_cobranca_id_fk" FOREIGN KEY ("cobranca_id") REFERENCES "public"."cobranca"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "venda_cota_uq" ON "venda" USING btree ("cota_id") WHERE status IN ('sinal_emitido','sinal_pago','registrando','registrada');--> statement-breakpoint
CREATE INDEX "venda_conversa_idx" ON "venda" USING btree ("conversa_id","criado_em");--> statement-breakpoint
CREATE INDEX "venda_status_idx" ON "venda" USING btree ("status");