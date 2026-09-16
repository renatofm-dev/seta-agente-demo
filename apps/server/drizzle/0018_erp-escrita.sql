CREATE TABLE "erp_escrita" (
	"chave" text PRIMARY KEY NOT NULL,
	"operacao" text NOT NULL,
	"alvo" text NOT NULL,
	"payload" jsonb NOT NULL,
	"estado" text DEFAULT 'pendente' NOT NULL,
	"erp_id" text,
	"tentativas" integer DEFAULT 0 NOT NULL,
	"erro" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "erp_escrita_estado_idx" ON "erp_escrita" USING btree ("estado","operacao");