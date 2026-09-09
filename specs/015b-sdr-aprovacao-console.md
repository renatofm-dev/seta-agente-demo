# 015b — SDR: aprovar ou recusar a proposta acima da alçada pelo console

> **Pré-spec** (rascunho de 08/09/2026): ainda não executada. Depende da 015a (no `main`).
> Item P-25 do roadmap, marco M1. Ao executar, revisar as premissas contra o código do momento.

## Objetivo
Hoje, quando o lead pede um valor abaixo do piso (tabela − 3%), a máquina do SDR encerra em
`aguardando_aprovacao`, grava a proposta e abre a pendência — e para aí. A tela de Leads
mostra a proposta com a nota "aprovar, contra-propor e recusar chegam com a 015b" e o lead
fica sem resposta até alguém falar com ele pela conversa. Esta spec fecha o ciclo: um humano
decide no console, o lead recebe a resposta pelo WhatsApp e a decisão fica no trace.

## Reaproveita
- `apps/server/src/sdr/leads-routes.ts`: `GET /api/console/leads` e `/leads/:id` já devolvem
  lead, fluxo, propostas e histórico; o badge `leadsAguardandoAprovacao` já conta
  `proposta_sdr.status = 'aguardando_aprovacao'` (`console-routes.ts › /resumo`).
- `apps/server/src/pagamentos/cobrancas-routes.ts`: `POST /cobrancas/:id/{aprovar,recusar}`
  é o molde (sessão, papel, motivo, transição + efeito, 409 em estado inválido).
- `packages/sdr/src/maquina.ts`: `encerrar(estado, 'aguardando_aprovacao')` é o ponto de
  saída; `render.ts` tem os textos do fluxo (falam em valor, nunca em percentual).
- `apps/server/src/sdr/{fluxo,escalar,repo}.ts`: efeitos e persistência da 015a.
- `apps/console/app/(console)/leads/page.tsx`: drawer com negociação (tabela, piso, pedido)
  e histórico; os botões existem no design (Aprovar desconto · Contra-proposta · Recusar).
- `apps/server/src/wa/outbox.ts › enqueueOutbound` com chave (`proposta:{id}:{seq}`) para
  mensagem fora de turno, como a confirmação de pagamento faz.

## Escopo

### Servidor (`apps/server/src/sdr/leads-routes.ts`)
- `POST /api/console/leads/:id/propostas/:pid/aprovar` — corpo vazio. Só para proposta em
  `aguardando_aprovacao`; grava `aprovado_por`, `aprovado_em`, status `aceita`; efeito:
  mensagem ao lead com o valor aprovado e o convite para agendar (texto novo em
  `render.ts`), fluxo volta para `agendamento` com a proposta aceita.
- `POST /api/console/leads/:id/propostas/:pid/recusar` — `{ motivo: string (1..280),
  contraproposta_centavos?: int }`. Sem contraproposta: status `recusada`, mensagem ao lead
  oferecendo o piso de novo; com contraproposta (≥ piso e ≤ tabela — fora disso 400): nova
  `proposta_sdr` `ofertada` com `origem: 'humano'`, mensagem ao lead com o valor, fluxo em
  `oferta`.
- Papel: `atendente` ou `curador` (qualquer sessão logada — POC sem papel comercial;
  registrar evolução em 032). Estado inválido ⇒ 409. Idempotente por proposta.
- Evento no trace da conversa: `{ tipo: 'proposta_decidida', decisao, por, motivo }` e
  `sinal_aprendizado` (tipo `decisao_humana_sdr`) para o distiller aprender o padrão de
  aprovação.
- `/resumo` continua contando pendências; SSE `ticket` não muda (o lead não é ticket).

### Máquina (`packages/sdr`)
- Ações novas: `aprovar_humano`, `recusar_humano`, `contrapropor_humano` a partir de
  `encerrado:aguardando_aprovacao` → `agendamento` | `encerrado:recusado` | `oferta`.
  Pura, testada em `packages/sdr/test/sdr.test.ts`.
- `render.ts`: `textoAprovado(valor)`, `textoRecusado(piso)`, `textoContraproposta(valor)`
  — sem a palavra desconto, sem percentual (varredura do vocabulário proibido cobre os
  novos).

### Console (`apps/console/app/(console)/leads/page.tsx`)
- Os três botões do drawer ligados: Aprovar (confirmação inline), Recusar (`ModalMotivo`,
  já existe em `components/ui/modal-motivo.tsx`), Contra-proposta (input de valor em reais
  com validação piso–tabela). Remove a nota "chega com a 015b".
- Histórico mostra a decisão com quem e quando; lista atualiza o chip para `Agendado` /
  `Perdido` conforme o desfecho.
- `lib/console-api.ts`: `aprovarProposta`, `recusarProposta`, `contrapropor`.

## Fora de escopo
- Papel `comercial` e permissão por papel (032).
- Prospecção ativa, raia do cotista, parcelamento (031).
- Aprovação em lote; notificação por e-mail/Slack da pendência (026 cobre só alerta de
  disponibilidade).
- Mudar `packages/guardrails/src/preco.ts` (015c cuida do percentual por extenso).

## Premissas
- A contraproposta humana **não** passa pela LLM: o texto é determinístico e o valor vem do
  console, validado contra `valor_tabela_centavos`/`valor_minimo_centavos` da proposta
  original; abaixo do piso só com aprovação explícita (é o mesmo caminho de `aprovar`).
- O lead responde à mensagem de decisão como qualquer turno: a máquina em `agendamento`
  ou `oferta` retoma de onde parou; janela de 24 h vencida ⇒ a mensagem vai por template
  (013), se existir modelo aprovado para isso; senão fica na fila até o lead falar.
- `proposta_sdr` ganha `decidido_por`, `decidido_em`, `motivo`, `origem` (`agente` |
  `humano`) — migração 0017.

## Critérios de aceite
- Lead pede valor abaixo do piso ⇒ proposta `aguardando_aprovacao`, badge da barra soma 1.
- Aprovar pelo console ⇒ proposta `aceita`, lead recebe o texto com o valor aprovado, fluxo
  em `agendamento`; "amanhã às 10" agenda e encerra `agendado`.
- Recusar com motivo ⇒ proposta `recusada`, lead recebe o texto oferecendo o piso; nova
  resposta do lead aceitando o piso segue para `agendamento`.
- Contraproposta dentro de piso–tabela ⇒ nova proposta `ofertada` com `origem: humano`,
  lead recebe o valor; fora da faixa ⇒ 400; proposta já decidida ⇒ 409.
- Trace da conversa tem `proposta_decidida`; `sinal_aprendizado` gravado.
- Varredura dos textos novos não contém `desconto|abatimento|cortesia|preço especial|
  condição especial|baixar o preço|faço por|%`.
- Teste de integração no molde de `sdr.integration.test.ts` cobrindo os três caminhos;
  `pnpm lint && pnpm test && pnpm build` verdes.
