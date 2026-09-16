/**
 * Extrai o CONTRATO da API do TS Explorer a partir da coleção Postman do
 * fornecedor (spec 035). Três responsabilidades, nesta ordem:
 *
 *  1. prova de procedência — confere o sha256 do original contra o registrado;
 *  2. sanitiza — a coleção crua tem tokens reais, e-mails, CPFs e telefones do
 *     fornecedor; nada disso pode entrar no git;
 *  3. deriva as fixtures — um arquivo por exemplo de resposta, mais um índice.
 *
 * Uso: TSE_COLLECTION_PATH=~/'Tse API.postman_collection.json' pnpm tse:fixtures
 * A coleção SANITIZADA vai para o repo: sem ambiente do fornecedor, ela É o
 * contrato — quem auditar as fixtures precisa da fonte para regenerá-las.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESTINO = join(RAIZ, 'apps/tse-sim/contrato');
const FIXTURES = join(DESTINO, 'fixtures');
const SHA_PATH = join(DESTINO, 'tse-api.collection.sha256');
const COLECAO_PATH = join(DESTINO, 'tse-api.collection.json');

// ---------------------------------------------------------------------------
// Sanitização

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EMAIL_FICTICIO = 'integracao@exemplo.com.br';
const PESSOA_FICTICIA = 'INTEGRACAO TSE';
const SCRUBBED = 'SCRUBBED';

/** Nomes próprios do fornecedor que aparecem em texto livre dos exemplos. */
const NOMES_REAIS = [/INTEGRA[ÇC][ÃA]O TSE/gi, /Juscelino Siqueira Junior/gi];

/** Chaves cujo VALOR é PII, independentemente do conteúdo. */
const CHAVES_PII: readonly (readonly [RegExp, string])[] = [
  [/^access_token$/i, SCRUBBED],
  [/^authorization$/i, SCRUBBED],
  [/^(Telefone|Fone)[A-Za-z]*$/i, ''],
  [/^(Email|EmailPessoa)$/i, EMAIL_FICTICIO],
  [
    /^(RazaoSocial|NomeFantasia|NomePessoa|NomeCessionario|NomeCompleto|RespCadNome|RespAltNome)$/,
    PESSOA_FICTICIA,
  ],
];

/** Chaves de telefone dentro de um contato (Numero/Ramal colidem com ids). */
const CHAVES_TELEFONE = /^(Numero|NumeroCompleto)$/;
const TELEFONE_FICTICIO = '999999999';

/**
 * Dígitos falsos ESTÁVEIS: o mesmo original vira sempre a mesma substituição,
 * para o exemplo continuar coerente (o CPF do path bate com o do corpo).
 */
function digitosEstaveis(original: string, tamanho: number): string {
  const h = createHash('sha256').update(original).digest('hex');
  let out = '';
  for (let i = 0; out.length < tamanho; i++) {
    out += String(Number.parseInt(h.slice((i * 8) % 56, ((i * 8) % 56) + 8), 16)).padStart(10, '0');
  }
  return out.slice(0, tamanho);
}

/**
 * CPF fictício com DV válido e PREFIXO 000 — o DV mantém a forma que o TSE
 * devolve, e o prefixo torna a origem verificável: todo CPF de 11 dígitos no
 * `contrato/` começa com 000, logo nenhum veio do fornecedor (o teste de
 * contrato prova isso, e é ele que substitui o grep cru por `[0-9]{11}`,
 * que casaria também com as substituições).
 */
const PREFIXO_CPF_FICTICIO = '000';
function cpfFicticio(original: string): string {
  const base = (PREFIXO_CPF_FICTICIO + digitosEstaveis(original, 6))
    .split('')
    .map((d) => Number(d));
  const dv = (nums: number[]) => {
    const soma = nums.reduce((acc, n, i) => acc + n * (nums.length + 1 - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const d1 = dv(base);
  return [...base, d1, dv([...base, d1])].join('');
}

/** Regras de texto — valem em qualquer string, inclusive dentro de corpo JSON. */
function sanitizarTexto(s: string): string {
  let out = s;
  // token no corpo do /token (o valor não é chave de objeto quando o corpo é texto)
  out = out.replace(/("access_token"\s*:\s*")[^"]*/g, `$1${SCRUBBED}`);
  if (out.startsWith('Bearer ')) out = `Bearer ${SCRUBBED}`;
  out = out.replace(EMAIL, EMAIL_FICTICIO);
  for (const re of NOMES_REAIS) out = out.replace(re, PESSOA_FICTICIA);
  // PII numérica: 11 dígitos = CPF; mais que isso = linha digitável, código de
  // barras, CNPJ — tudo dado bancário do fornecedor, nada disso é forma
  out = out.replace(/\d{11,}/g, (m) =>
    m.length === 11 ? cpfFicticio(m) : digitosEstaveis(m, m.length),
  );
  // valores cifrados de telefone que o TSE devolve em base64
  out = out.replace(/[A-Za-z0-9+/]{16,}={1,2}[A-Za-z0-9+/=]*/g, SCRUBBED);
  return out;
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function sanitizar(valor: Json, chave = '', dentroDeContato = false): Json {
  if (typeof valor === 'string') {
    for (const [re, substituto] of CHAVES_PII) if (re.test(chave)) return substituto;
    if (dentroDeContato && CHAVES_TELEFONE.test(chave)) return TELEFONE_FICTICIO;
    return sanitizarTexto(valor);
  }
  if (typeof valor === 'number') {
    if (dentroDeContato && CHAVES_TELEFONE.test(chave)) return Number(TELEFONE_FICTICIO);
    return valor;
  }
  if (Array.isArray(valor)) return valor.map((v) => sanitizar(v, chave, dentroDeContato));
  if (valor && typeof valor === 'object') {
    const contato = dentroDeContato || Object.hasOwn(valor, 'IdContatoTelefonico');
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(valor)) out[k] = sanitizar(v, k, contato);
    return out;
  }
  return valor;
}

/**
 * Corpo de exemplo: JSON quando dá para parsear (aí a sanitização é ciente da
 * chave), texto quando não dá. Os bodies de CriarUtilizacaoContrato e
 * AdicionarHospede trazem comentário `//...` — JSON.parse quebra sem este passe.
 */
function semComentarios(texto: string): string {
  return texto.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
}

function corpoSanitizado(texto: string): { json: Json | undefined; texto: string } {
  for (const candidato of [texto, semComentarios(texto)]) {
    try {
      const json = sanitizar(JSON.parse(candidato) as Json);
      return { json, texto: JSON.stringify(json, null, 4) };
    } catch {
      // segue para o próximo candidato
    }
  }
  return { json: undefined, texto: sanitizarTexto(texto) };
}

// ---------------------------------------------------------------------------
// Extração

interface ParPostman {
  readonly key: string;
  readonly value?: string;
}
interface UrlPostman {
  readonly path?: readonly string[];
  readonly query?: readonly ParPostman[];
}
interface RequisicaoPostman {
  readonly method?: string;
  readonly url?: UrlPostman | string;
  readonly body?: {
    readonly mode?: string;
    readonly raw?: string;
    readonly urlencoded?: readonly ParPostman[];
  };
}
interface RespostaPostman {
  readonly name?: string;
  readonly code?: number;
  readonly header?: readonly ParPostman[];
  readonly body?: string;
  readonly originalRequest?: RequisicaoPostman;
  readonly _postman_previewlanguage?: string;
}
interface ItemPostman {
  readonly name?: string;
  readonly item?: readonly ItemPostman[];
  readonly request?: RequisicaoPostman;
  readonly response?: readonly RespostaPostman[];
}

export interface Fixture {
  readonly nome: string;
  readonly pasta: string;
  readonly method: string;
  /** Caminho com os segmentos variáveis preservados como `{{nome}}`. */
  readonly path: string;
  readonly pathParams: readonly string[];
  readonly query: readonly string[];
  readonly requestBody: Json | string | null;
  readonly status: number;
  readonly contentType: string;
  /** Ausente quando o corpo é binário — ver `bodySha256`. */
  readonly body?: Json | string;
  /**
   * Corpo binário (o PDF da 2ª via) NÃO vai para o repo: é um boleto real, com
   * cedente, CPF e código de barras de gente de verdade, e nenhuma regra de
   * sanitização alcança bytes de PDF. A 040 precisa da FORMA (content-type e
   * que são bytes), não do documento — o hash prova qual exemplo foi lido.
   */
  readonly bodySha256?: string;
  readonly bodyBytes?: number;
}

const kebab = (s: string): string =>
  s
    .replace(/\[[^\]]*\]/g, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

function urlDe(req: RequisicaoPostman | undefined): UrlPostman {
  const url = req?.url;
  return typeof url === 'object' && url !== null ? url : {};
}

function extrair(pasta: string, item: ItemPostman): Fixture[] {
  const saida: Fixture[] = [];
  for (const resposta of item.response ?? []) {
    const req = resposta.originalRequest ?? item.request;
    const reqComCorpo = req?.body ? req : (item.request ?? req);
    const url = urlDe(req);
    const segmentos = url.path ?? [];
    const contentType =
      (resposta.header ?? []).find((h) => h.key.toLowerCase() === 'content-type')?.value ??
      'application/json';
    const binario = !contentType.includes('json') && resposta._postman_previewlanguage === 'pdf';
    const corpoReq =
      reqComCorpo?.body?.mode === 'urlencoded'
        ? Object.fromEntries((reqComCorpo.body.urlencoded ?? []).map((p) => [p.key, p.value ?? '']))
        : reqComCorpo?.body?.raw
          ? (corpoSanitizado(reqComCorpo.body.raw).json ?? sanitizarTexto(reqComCorpo.body.raw))
          : null;
    const base = {
      nome: `${kebab(pasta)}__${kebab(item.name ?? resposta.name ?? 'sem-nome')}`,
      pasta,
      method: (req?.method ?? 'GET').toUpperCase(),
      path: `/${segmentos.join('/')}`,
      pathParams: segmentos.filter((s) => s.startsWith('{{')).map((s) => s.slice(2, -2)),
      query: (url.query ?? []).map((q) => q.key),
      requestBody: corpoReq as Json | string | null,
      status: resposta.code ?? 200,
      contentType,
    };
    const corpo = resposta.body ?? '';
    saida.push(
      binario
        ? {
            ...base,
            bodySha256: createHash('sha256').update(Buffer.from(corpo, 'latin1')).digest('hex'),
            bodyBytes: Buffer.from(corpo, 'latin1').length,
          }
        : { ...base, body: corpoSanitizado(corpo).json ?? sanitizarTexto(corpo) },
    );
  }
  return saida;
}

// ---------------------------------------------------------------------------

function main(): void {
  const origem = process.env.TSE_COLLECTION_PATH;
  if (!origem) {
    throw new Error(
      'defina TSE_COLLECTION_PATH com o caminho da coleção Postman ORIGINAL do fornecedor',
    );
  }
  const cru = readFileSync(origem);
  const sha = createHash('sha256').update(cru).digest('hex');
  let registrado: string | undefined;
  try {
    registrado = readFileSync(SHA_PATH, 'utf-8').trim().split(/\s+/)[0];
  } catch {
    registrado = undefined;
  }
  const aceitarNova = process.argv.includes('--nova');
  if (registrado && registrado !== sha && !aceitarNova) {
    throw new Error(
      `a coleção mudou — sha256 registrado ${registrado}, lido ${sha}.\n` +
        'O contrato do fornecedor não muda em silêncio: revise o diff e rode com --nova.',
    );
  }

  const colecao = sanitizar(JSON.parse(cru.toString('utf-8')) as Json) as unknown as {
    item?: readonly ItemPostman[];
  };
  const fixtures: Fixture[] = [];
  for (const pasta of colecao.item ?? []) {
    for (const item of pasta.item ?? []) fixtures.push(...extrair(pasta.name ?? 'raiz', item));
  }
  // nomes repetidos (o mesmo request em duas pastas) ganham sufixo estável
  const vistos = new Map<string, number>();
  const finais = fixtures.map((f) => {
    const n = (vistos.get(f.nome) ?? 0) + 1;
    vistos.set(f.nome, n);
    return n === 1 ? f : { ...f, nome: `${f.nome}-${n}` };
  });

  rmSync(FIXTURES, { recursive: true, force: true });
  mkdirSync(FIXTURES, { recursive: true });
  for (const f of finais) {
    writeFileSync(join(FIXTURES, `${f.nome}.json`), `${JSON.stringify(f, null, 2)}\n`);
  }
  const indice = finais.map(
    ({ nome, pasta, method, path, pathParams, query, status, contentType }) => ({
      nome,
      pasta,
      method,
      path,
      pathParams,
      query,
      status,
      contentType,
      arquivo: `fixtures/${nome}.json`,
    }),
  );
  writeFileSync(join(DESTINO, 'indice.json'), `${JSON.stringify(indice, null, 2)}\n`);
  writeFileSync(COLECAO_PATH, `${JSON.stringify(colecao, null, 2)}\n`);
  writeFileSync(SHA_PATH, `${sha}  ${origem.split('/').pop()}\n`);

  const arquivos = readdirSync(FIXTURES).length;
  console.log(
    `contrato do TSE: ${arquivos} fixtures, ${indice.length} exemplos, sha256 ${sha.slice(0, 12)}…`,
  );
}

main();
