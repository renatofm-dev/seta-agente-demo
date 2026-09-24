CREATE TABLE "assinatura" (
	"id" uuid PRIMARY KEY NOT NULL,
	"venda_id" uuid NOT NULL,
	"conversa_id" uuid NOT NULL,
	"provedor" text NOT NULL,
	"documento_id" text NOT NULL,
	"contrato_erp_id" text NOT NULL,
	"estado" text NOT NULL,
	"link" text NOT NULL,
	"assinado_em" timestamp with time zone,
	"url_assinado" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assinatura" ADD CONSTRAINT "assinatura_venda_id_venda_id_fk" FOREIGN KEY ("venda_id") REFERENCES "public"."venda"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assinatura" ADD CONSTRAINT "assinatura_conversa_id_conversa_id_fk" FOREIGN KEY ("conversa_id") REFERENCES "public"."conversa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assinatura_documento_uq" ON "assinatura" USING btree ("provedor","documento_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assinatura_venda_uq" ON "assinatura" USING btree ("venda_id") WHERE estado = 'pendente';--> statement-breakpoint
CREATE INDEX "assinatura_venda_idx" ON "assinatura" USING btree ("venda_id");