-- #36: taxonomia da spec 009 — renomeia o tipo de sinal existente
UPDATE "sinal_aprendizado" SET "tipo" = 'verdict_guardrail' WHERE "tipo" = 'guardrail_verdict';--> statement-breakpoint
-- #37: taxaResolucao consulta contexto->'skillIds' por containment em todo turno
CREATE INDEX IF NOT EXISTS "trace_turno_contexto_gin" ON "trace_turno" USING gin ("contexto" jsonb_path_ops);
