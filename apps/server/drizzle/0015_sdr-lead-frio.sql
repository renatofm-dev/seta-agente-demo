CREATE TABLE "fluxo_sdr" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversa_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"etapa" text NOT NULL,
	"encerramento" text,
	"perfil" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"opcoes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"escolha" integer,
	"oferta" text,
	"nao_entendi" integer DEFAULT 0 NOT NULL,
	"proposta_id" uuid,
	"expira_em" timestamp with time zone NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead" (
	"id" uuid PRIMARY KEY NOT NULL,
	"wa_id" text NOT NULL,
	"nome" text,
	"origem" text DEFAULT 'inbound' NOT NULL,
	"perfil" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'novo' NOT NULL,
	"conversa_id" uuid,
	"trace_id" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_wa_id_uq" UNIQUE("wa_id")
);
--> statement-breakpoint
CREATE TABLE "proposta_sdr" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"fluxo_id" uuid,
	"conversa_id" uuid NOT NULL,
	"cota_id" text NOT NULL,
	"cota_codigo" text NOT NULL,
	"referencia" text NOT NULL,
	"valor_tabela_centavos" integer NOT NULL,
	"valor_minimo_centavos" integer NOT NULL,
	"valor_ofertado_centavos" integer NOT NULL,
	"desconto_bps" integer DEFAULT 0 NOT NULL,
	"valor_pedido_centavos" integer,
	"status" text NOT NULL,
	"motivo" text,
	"aprovado_por" text,
	"aprovado_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fluxo_sdr" ADD CONSTRAINT "fluxo_sdr_conversa_id_conversa_id_fk" FOREIGN KEY ("conversa_id") REFERENCES "public"."conversa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fluxo_sdr" ADD CONSTRAINT "fluxo_sdr_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_conversa_id_conversa_id_fk" FOREIGN KEY ("conversa_id") REFERENCES "public"."conversa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposta_sdr" ADD CONSTRAINT "proposta_sdr_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposta_sdr" ADD CONSTRAINT "proposta_sdr_fluxo_id_fluxo_sdr_id_fk" FOREIGN KEY ("fluxo_id") REFERENCES "public"."fluxo_sdr"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposta_sdr" ADD CONSTRAINT "proposta_sdr_conversa_id_conversa_id_fk" FOREIGN KEY ("conversa_id") REFERENCES "public"."conversa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fluxo_sdr_ativo_uq" ON "fluxo_sdr" USING btree ("conversa_id") WHERE etapa <> 'encerrado';--> statement-breakpoint
CREATE UNIQUE INDEX "proposta_sdr_referencia_aberta_uq" ON "proposta_sdr" USING btree ("referencia") WHERE status IN ('ofertada', 'aguardando_aprovacao');--> statement-breakpoint
CREATE INDEX "proposta_sdr_conversa_idx" ON "proposta_sdr" USING btree ("conversa_id","criado_em");--> statement-breakpoint
CREATE INDEX "proposta_sdr_lead_idx" ON "proposta_sdr" USING btree ("lead_id","criado_em");