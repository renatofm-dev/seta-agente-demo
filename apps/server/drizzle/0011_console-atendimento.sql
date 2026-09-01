CREATE TABLE "conversa_leitura" (
	"conversa_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"lida_ate" timestamp with time zone NOT NULL,
	CONSTRAINT "conversa_leitura_conversa_id_user_id_pk" PRIMARY KEY("conversa_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "mensagem" ADD COLUMN "atendente_id" text;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "atendente_id" text;--> statement-breakpoint
ALTER TABLE "conversa_leitura" ADD CONSTRAINT "conversa_leitura_conversa_id_conversa_id_fk" FOREIGN KEY ("conversa_id") REFERENCES "public"."conversa"("id") ON DELETE no action ON UPDATE no action;