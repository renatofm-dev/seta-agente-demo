# 033 — Mídia no WhatsApp: fotos, áudio e documentos

> **Pré-spec / rascunho M5** (08/09/2026): corte da 000/004 ("só texto"). Depende do piloto
> mostrar a demanda real e da 023 (mídia em template).

## Objetivo
O cotista manda foto do comprovante, áudio perguntando da parcela e PDF do contrato; o
agente hoje ignora tudo que não é texto. Nos dois sentidos: receber (transcrever áudio,
descrever/anexar imagem e documento ao ticket) e enviar (boleto em PDF, comprovante, imagem
do template).

## Reaproveita
- `packages/wa-meta` (`parseInboundTexts` vira `parseInbound` com tipos), gateway de envio,
  `mensagem` (ganha `tipo`, `midia_id`, `mime`, `url`).
- `packages/anonimizacao` (transcrição passa pelo mesmo decorator).
- Outbox e templates (013/030) para o envio.
- Armazenamento: volume da instalação (021) ou objeto no provedor do cliente.

## Escopo
- Inbound: download da mídia pela Graph API (URL expira), armazenamento com retenção
  (024), `mensagem.tipo` ∈ texto, imagem, audio, documento; áudio ⇒ transcrição
  (`AIProvider.transcribe` novo, provedor a decidir — pode ser local) e o texto entra no
  turno com a marca "(áudio transcrito)"; imagem/documento ⇒ o agente responde que recebeu
  e anexa ao ticket; comprovante de pagamento ⇒ escala para conciliação humana.
- Outbound: boleto em PDF (link do PSP já existe; anexar o arquivo é opcional), template
  com header de imagem (030).
- Console: mídia visível no painel da conversa com player/preview; download com auditoria.

## Fora de escopo
- OCR de comprovante para baixa automática; vídeo; localização; figurinhas.

## Premissas
- Mídia é dado pessoal por natureza: retenção curta por default (024) e nunca sai para a
  LLM sem anonimização (imagem não vai para a LLM nesta fase).

## Critérios de aceite
- Áudio "quanto falta pagar?" ⇒ transcrito, respondido com dado do ERP, trace registra a
  transcrição; foto de comprovante ⇒ anexada ao ticket e escalada; boleto sai como PDF
  quando o cliente pede; mídia expira conforme a política.
