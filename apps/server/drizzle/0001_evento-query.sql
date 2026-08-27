CREATE TABLE "evento_query" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"ok" boolean NOT NULL,
	"latency_ms" integer NOT NULL,
	"linhas" integer NOT NULL,
	"truncated" boolean NOT NULL,
	"erro" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
