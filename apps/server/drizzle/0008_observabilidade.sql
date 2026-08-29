CREATE TABLE "evento_escalonamento" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"conversa_id" uuid NOT NULL,
	"turno_id" uuid,
	"ticket_id" uuid,
	"motivo" text NOT NULL,
	"origem" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evento_guardrail" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"conversa_id" uuid NOT NULL,
	"turno_id" uuid,
	"ticket_id" uuid,
	"guardrail" text NOT NULL,
	"hook" text NOT NULL,
	"verdict" text NOT NULL,
	"motivo" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evento_llm" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"conversa_id" uuid NOT NULL,
	"turno_id" uuid,
	"ticket_id" uuid,
	"modelo" text NOT NULL,
	"tokens_entrada" integer NOT NULL,
	"tokens_saida" integer NOT NULL,
	"latencia_ms" integer NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
