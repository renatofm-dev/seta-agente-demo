CREATE TABLE "caso_eval" (
	"id" uuid PRIMARY KEY NOT NULL,
	"input" text NOT NULL,
	"comportamento_esperado" text NOT NULL,
	"origem" jsonb NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposta" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tipo" text NOT NULL,
	"skill_id" uuid,
	"diff" text NOT NULL,
	"frontmatter" jsonb NOT NULL,
	"evidencia" jsonb NOT NULL,
	"sinais" jsonb NOT NULL,
	"status" text DEFAULT 'aberta' NOT NULL,
	"motivo_rejeicao" text,
	"revisado_por" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill" (
	"id" uuid PRIMARY KEY NOT NULL,
	"id_logico" text NOT NULL,
	"escopo" text DEFAULT 'local' NOT NULL,
	"fork_de" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_id_logico_unique" UNIQUE("id_logico")
);
--> statement-breakpoint
CREATE TABLE "skill_versao" (
	"id" uuid PRIMARY KEY NOT NULL,
	"skill_id" uuid NOT NULL,
	"versao" integer NOT NULL,
	"corpo" text NOT NULL,
	"frontmatter" jsonb NOT NULL,
	"embedding" jsonb,
	"status" text NOT NULL,
	"criado_por" text NOT NULL,
	"aprovado_por" text,
	"aprovado_em" timestamp with time zone,
	"proposta_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_versao_skill_versao_unique" UNIQUE("skill_id","versao")
);
--> statement-breakpoint
ALTER TABLE "sinal_aprendizado" ADD COLUMN "processado_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proposta" ADD CONSTRAINT "proposta_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versao" ADD CONSTRAINT "skill_versao_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE no action ON UPDATE no action;