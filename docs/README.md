# Documentação do seta-agente

Porta de entrada para quem desenvolve a plataforma de atendimento da SETA. Tudo aqui é
versionado e muda por PR, como o código. O que é decisão de negócio ou calendário vive no
roadmap; o que é comportamento vive nas specs; o resto está nos guias abaixo.

## Leia nesta ordem se está chegando agora

| # | Documento | Abra quando quiser… |
|---|---|---|
| 1 | [Visão geral](dev/01-visao-geral.md) | entender o produto em uma página e os princípios que não se negociam |
| 2 | [Arquitetura](dev/02-arquitetura.md) | ver como um turno, uma cobrança ou uma venda atravessam o sistema; ports, filas e fronteiras |
| 3 | [Mapa do repositório](dev/03-mapa-do-repositorio.md) | achar onde cada coisa mora (packages, server, console, catálogo, infra) |
| 4 | [Módulos entregues](dev/04-modulos-entregues.md) | saber o que cada spec (000–017) entregou, onde está e como exercitar |
| 5 | [Dados e integrações](dev/05-dados-e-integracoes.md) | mexer no banco, no espelho do ERP, no catálogo de queries, nas integrações ou nas variáveis de ambiente |
| 6 | [Como desenvolver](dev/06-como-desenvolver.md) | subir o ambiente, rodar testes, seguir as convenções, escrever uma spec, abrir um PR |
| 7 | [Operação e deploy](dev/07-operacao-e-deploy.md) | entender CI, release, imagens, homelab e observabilidade |
| 8 | [O que falta](dev/08-o-que-falta.md) | ver o que ainda vai ser construído, por marco, com link para cada pré-spec |
| 9 | [WhatsApp real e o túnel](dev/09-whatsapp-real-e-tunel.md) | testar com o número de WhatsApp: por que o túnel, por que o override é por número, o que `pnpm dev-whatsapp` faz e como diagnosticar |

## Referências

- **Specs** — [`specs/`](../specs/README.md): uma spec = uma sessão = um PR. As entregues
  (000–017) são a fonte de verdade do comportamento; as pré-specs (015b, 015c, 018–034) são
  o escopo desenhado do que falta.
- **Roadmap** — [`roadmap.md`](roadmap.md): marcos M0–M5, datas, decisões D1–D9 com dono e
  prazo, itens do backlog da empresa. Para os sócios (Parte 1) e para o time (Parte 2).
- **Status do projeto** — [`status-do-projeto.md`](status-do-projeto.md): fotografia de
  31/08 para os sócios, com a atualização de 08/09 no topo.
- **Decisões de arquitetura** — [`adr/`](adr/): uma decisão por arquivo
  (`0001-asaas-como-psp.md`). Decisões menores estão em "Decisões registradas" no
  [`CLAUDE.md`](../CLAUDE.md).

## Guias operacionais

| Guia | Para quê |
|---|---|
| [`meta-setup.md`](meta-setup.md) | App Meta, número de teste, token, webhook e diagnóstico do WhatsApp |
| [`asaas-setup.md`](asaas-setup.md) | Sandbox do Asaas, webhook de pagamento, simulação, limites |
| [`tse-api-setup.md`](tse-api-setup.md) | API HTTP do TS Explorer: contrato, autenticação, mapeamento no domínio, armadilhas e como rodar contra o simulador |
| [`deploy-homelab.md`](deploy-homelab.md) | Preparar a VPS, login no GHCR, Caddy, `.env.prod`, deploy e seed de demo |
| [`roteiro-demo.md`](roteiro-demo.md) | Os cinco atos da demonstração e o plano B pelo simulador |

## Regras que valem para tudo

Estão no [`CLAUDE.md`](../CLAUDE.md) da raiz (stack travada, escopo por spec, fronteiras,
segurança, convenções, fluxo git) e detalhadas em [Como desenvolver](dev/06-como-desenvolver.md).
