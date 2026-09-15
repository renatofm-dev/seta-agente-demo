-- 043: template com order_details para a cobrança fora da janela de 24h.
-- A linha do outbox carrega, opcionalmente, o template equivalente ao texto.
-- Quem decide entre texto e template é o WORKER, no instante do envio: a janela
-- pode fechar entre o INSERT e o envio (o backoff do pg-boss atravessa a
-- fronteira), então a emissão não tem como decidir sozinha.
ALTER TABLE "outbox" ADD COLUMN "template" jsonb;