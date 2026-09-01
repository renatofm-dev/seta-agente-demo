CREATE TABLE "disparo" (
	"id" uuid PRIMARY KEY NOT NULL,
	"modelo_id" uuid NOT NULL,
	"variaveis" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'enviando' NOT NULL,
	"criado_por" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disparo_destinatario" (
	"id" uuid PRIMARY KEY NOT NULL,
	"disparo_id" uuid NOT NULL,
	"wa_id" text NOT NULL,
	"contato_nome" text,
	"status" text DEFAULT 'pendente' NOT NULL,
	"wa_message_id" text,
	"erro" text,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disparo_destinatario_wa_message_id_unique" UNIQUE("wa_message_id")
);
--> statement-breakpoint
CREATE TABLE "modelo_mensagem" (
	"id" uuid PRIMARY KEY NOT NULL,
	"nome" text NOT NULL,
	"idioma" text DEFAULT 'pt_BR' NOT NULL,
	"categoria" text DEFAULT 'utility' NOT NULL,
	"corpo" text NOT NULL,
	"rodape" text,
	"meta_id" text,
	"status_meta" text DEFAULT 'pendente' NOT NULL,
	"motivo_rejeicao" text,
	"criado_por" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modelo_mensagem_nome_unique" UNIQUE("nome")
);
--> statement-breakpoint
ALTER TABLE "disparo" ADD CONSTRAINT "disparo_modelo_id_modelo_mensagem_id_fk" FOREIGN KEY ("modelo_id") REFERENCES "public"."modelo_mensagem"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disparo_destinatario" ADD CONSTRAINT "disparo_destinatario_disparo_id_disparo_id_fk" FOREIGN KEY ("disparo_id") REFERENCES "public"."disparo"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "disparo_destinatario_disparo_idx" ON "disparo_destinatario" USING btree ("disparo_id");