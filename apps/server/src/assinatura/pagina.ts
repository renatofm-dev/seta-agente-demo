/**
 * 046 — a página de assinatura do provedor simulado.
 *
 * HTML escrito à mão, sem framework e sem asset externo: ela é servida pelo
 * server (a única porta que atravessa o túnel em dev) e precisa abrir rápido
 * num celular, possivelmente em 3G, dentro do navegador do WhatsApp.
 *
 * A tarja de simulação é obrigatória e fica no topo. Uma tela de assinatura
 * que PARECE jurídica e não é seria pior do que tela nenhuma — a mesma regra
 * que a 040 aplicou ao boleto e ao contrato em PDF.
 */

export interface LinhaAssinatura {
  readonly documentoId: string;
  readonly contratoErpId: string;
  readonly assinadoEm: Date | null;
}

/** Texto em HTML: escapa o que fecha tag ou atributo. */
function escapar(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const ESTILO = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 20px 48px;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    max-width: 34rem; margin-inline: auto;
  }
  .tarja {
    border: 1px solid currentColor; border-radius: 8px; padding: 10px 12px;
    font-size: 13px; opacity: .75; margin-bottom: 24px;
  }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .cliente { font-size: 14px; opacity: .7; margin: 0 0 24px; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; margin: 0 0 28px; }
  dt { font-size: 13px; opacity: .65; }
  dd { margin: 0; font-weight: 600; }
  a.ver { display: inline-block; margin-bottom: 28px; }
  button {
    width: 100%; padding: 16px; font-size: 17px; font-weight: 600;
    border: 0; border-radius: 10px; cursor: pointer;
    background: #1f7a3f; color: #fff;
  }
  .ok { font-size: 17px; font-weight: 600; color: #1f7a3f; }
  footer { margin-top: 32px; font-size: 13px; opacity: .6; }
`;

function moldura(cliente: string, corpo: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Assinatura de contrato</title>
<style>${ESTILO}</style>
<body>
  <p class="tarja">Ambiente de demonstração. Esta assinatura é simulada e não tem validade jurídica.</p>
  ${corpo}
  <footer>${escapar(cliente)}</footer>
</body>
</html>`;
}

export function paginaSimples(cliente: string, titulo: string, texto: string): string {
  return moldura(cliente, `<h1>${escapar(titulo)}</h1><p>${escapar(texto)}</p>`);
}

export function paginaDeAssinatura(cliente: string, linha: LinhaAssinatura): string {
  const id = escapar(linha.documentoId);
  return moldura(
    cliente,
    `<h1>Assinar contrato</h1>
  <p class="cliente">${escapar(cliente)}</p>
  <dl>
    <dt>Contrato</dt><dd>nº ${escapar(linha.contratoErpId)}</dd>
  </dl>
  <a class="ver" href="/assinar/${id}/contrato.pdf">Ler o contrato (PDF)</a>
  <form method="post" action="/assinar/${id}">
    <button type="submit">Assinar contrato</button>
  </form>`,
  );
}

export function paginaAssinada(cliente: string, linha: LinhaAssinatura): string {
  const quando = linha.assinadoEm
    ? linha.assinadoEm.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    : null;
  return moldura(
    cliente,
    `<h1>Contrato assinado</h1>
  <p class="ok">Tudo certo ✓</p>
  <dl>
    <dt>Contrato</dt><dd>nº ${escapar(linha.contratoErpId)}</dd>
    ${quando ? `<dt>Assinado em</dt><dd>${escapar(quando)}</dd>` : ''}
  </dl>
  <p>A via assinada foi enviada no seu WhatsApp. Pode voltar para a conversa.</p>`,
  );
}
