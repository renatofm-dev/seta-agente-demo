CREATE TABLE "cobranca" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversa_id" uuid NOT NULL,
	"contrato_id" text NOT NULL,
	"referencia_externa" text NOT NULL,
	"status" text NOT NULL,
	"metodo" text NOT NULL,
	"valor_centavos" integer NOT NULL,
	"vencimento_psp" date NOT NULL,
	"psp" text NOT NULL,
	"psp_cliente_id" text,
	"psp_cobranca_id" text,
	"url_fatura" text,
	"url_boleto" text,
	"linha_digitavel" text,
	"pix_copia_cola" text,
	"pix_expira_em" text,
	"motivo" text,
	"aprovado_por" text,
	"aprovado_em" timestamp with time zone,
	"pago_em" timestamp with time zone,
	"tentativas" integer DEFAULT 0 NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cobranca_titulo" (
	"cobranca_id" uuid NOT NULL,
	"titulo_id" text NOT NULL,
	"origem" text NOT NULL,
	"parcela" integer NOT NULL,
	"total_parcelas" integer,
	"valor_centavos" integer NOT NULL,
	"vencimento" date NOT NULL,
	CONSTRAINT "cobranca_titulo_cobranca_id_titulo_id_pk" PRIMARY KEY("cobranca_id","titulo_id")
);
--> statement-breakpoint
CREATE TABLE "evento_psp" (
	"id" text PRIMARY KEY NOT NULL,
	"psp" text NOT NULL,
	"tipo" text NOT NULL,
	"psp_cobranca_id" text,
	"payload" jsonb NOT NULL,
	"recebido_em" timestamp with time zone DEFAULT now() NOT NULL,
	"processado_em" timestamp with time zone,
	"erro" text
);
--> statement-breakpoint
CREATE TABLE "fluxo_cobranca" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversa_id" uuid NOT NULL,
	"contrato_id" text NOT NULL,
	"etapa" text NOT NULL,
	"encerramento" text,
	"candidatos" jsonb NOT NULL,
	"selecao" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metodo" text,
	"nao_entendi" integer DEFAULT 0 NOT NULL,
	"cobranca_id" uuid,
	"expira_em" timestamp with time zone NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pagamento" (
	"id" uuid PRIMARY KEY NOT NULL,
	"contrato_id" text NOT NULL,
	"titulo_id" text NOT NULL,
	"cobranca_id" uuid NOT NULL,
	"valor_centavos" integer NOT NULL,
	"metodo" text NOT NULL,
	"recebido_em" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'confirmado' NOT NULL,
	"evento_psp_id" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pagamento_cobranca_titulo_uq" UNIQUE("cobranca_id","titulo_id")
);
--> statement-breakpoint
CREATE TABLE "psp_cliente" (
	"psp" text NOT NULL,
	"contrato_id" text NOT NULL,
	"psp_cliente_id" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "psp_cliente_psp_contrato_id_pk" PRIMARY KEY("psp","contrato_id")
);
--> statement-breakpoint
ALTER TABLE "contato" ADD COLUMN "documento" text;--> statement-breakpoint
ALTER TABLE "cobranca" ADD CONSTRAINT "cobranca_conversa_id_conversa_id_fk" FOREIGN KEY ("conversa_id") REFERENCES "public"."conversa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobranca_titulo" ADD CONSTRAINT "cobranca_titulo_cobranca_id_cobranca_id_fk" FOREIGN KEY ("cobranca_id") REFERENCES "public"."cobranca"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fluxo_cobranca" ADD CONSTRAINT "fluxo_cobranca_conversa_id_conversa_id_fk" FOREIGN KEY ("conversa_id") REFERENCES "public"."conversa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagamento" ADD CONSTRAINT "pagamento_cobranca_id_cobranca_id_fk" FOREIGN KEY ("cobranca_id") REFERENCES "public"."cobranca"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cobranca_referencia_aberta_uq" ON "cobranca" USING btree ("referencia_externa") WHERE status IN ('aguardando_aprovacao', 'emitindo', 'emitida');--> statement-breakpoint
CREATE INDEX "cobranca_psp_idx" ON "cobranca" USING btree ("psp_cobranca_id");--> statement-breakpoint
CREATE INDEX "cobranca_contrato_idx" ON "cobranca" USING btree ("contrato_id","criado_em");--> statement-breakpoint
CREATE INDEX "cobranca_conversa_idx" ON "cobranca" USING btree ("conversa_id","criado_em");--> statement-breakpoint
CREATE INDEX "evento_psp_cobranca_idx" ON "evento_psp" USING btree ("psp_cobranca_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fluxo_cobranca_ativo_uq" ON "fluxo_cobranca" USING btree ("conversa_id") WHERE etapa <> 'encerrado';--> statement-breakpoint
CREATE INDEX "pagamento_contrato_idx" ON "pagamento" USING btree ("contrato_id","status");