CREATE TABLE "supressao" (
	"wa_id" text PRIMARY KEY NOT NULL,
	"origem" text NOT NULL,
	"detalhe" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
