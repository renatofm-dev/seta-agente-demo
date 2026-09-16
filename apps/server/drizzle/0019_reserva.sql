CREATE TABLE "fluxo_reserva" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversa_id" uuid NOT NULL,
	"contrato_id" text NOT NULL,
	"etapa" text NOT NULL,
	"encerramento" text,
	"estado" jsonb NOT NULL,
	"nao_entendi" integer DEFAULT 0 NOT NULL,
	"reserva_id" uuid,
	"expira_em" timestamp with time zone NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reserva" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversa_id" uuid NOT NULL,
	"contrato_id" text NOT NULL,
	"status" text NOT NULL,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"id_hotel" integer NOT NULL,
	"hotel" text,
	"id_tipo_uh" integer NOT NULL,
	"tipo_uh" text,
	"adultos" integer NOT NULL,
	"criancas" integer DEFAULT 0 NOT NULL,
	"hospedes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custo_pontos" integer NOT NULL,
	"taxa_centavos" integer NOT NULL,
	"erp_utilizacao_id" text,
	"motivo" text,
	"aprovado_por" text,
	"aprovado_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fluxo_reserva" ADD CONSTRAINT "fluxo_reserva_conversa_id_conversa_id_fk" FOREIGN KEY ("conversa_id") REFERENCES "public"."conversa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reserva" ADD CONSTRAINT "reserva_conversa_id_conversa_id_fk" FOREIGN KEY ("conversa_id") REFERENCES "public"."conversa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fluxo_reserva_ativo_uq" ON "fluxo_reserva" USING btree ("conversa_id") WHERE etapa <> 'encerrado';--> statement-breakpoint
CREATE UNIQUE INDEX "reserva_periodo_uq" ON "reserva" USING btree ("contrato_id","check_in","check_out","id_hotel","id_tipo_uh") WHERE status IN ('aguardando_aprovacao','criando','criada','confirmada');--> statement-breakpoint
CREATE INDEX "reserva_conversa_idx" ON "reserva" USING btree ("conversa_id","criado_em");--> statement-breakpoint
CREATE INDEX "reserva_status_idx" ON "reserva" USING btree ("status");