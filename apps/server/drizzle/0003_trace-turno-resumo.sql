CREATE TABLE "trace_turno" (
	"id" uuid PRIMARY KEY NOT NULL,
	"turno_id" uuid NOT NULL,
	"conversa_id" uuid NOT NULL,
	"trace_id" text NOT NULL,
	"contexto" jsonb NOT NULL,
	"eventos" jsonb NOT NULL,
	"resposta" text NOT NULL,
	"escalado" boolean NOT NULL,
	"fallback" boolean NOT NULL,
	"fallback_motivo" text,
	"tokens_entrada" integer NOT NULL,
	"tokens_saida" integer NOT NULL,
	"latencia_ms" integer NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversa" ADD COLUMN "resumo" text;--> statement-breakpoint
ALTER TABLE "conversa" ADD COLUMN "turnos_desde_resumo" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "trace_turno" ADD CONSTRAINT "trace_turno_turno_id_turno_id_fk" FOREIGN KEY ("turno_id") REFERENCES "public"."turno"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_turno" ADD CONSTRAINT "trace_turno_conversa_id_conversa_id_fk" FOREIGN KEY ("conversa_id") REFERENCES "public"."conversa"("id") ON DELETE no action ON UPDATE no action;