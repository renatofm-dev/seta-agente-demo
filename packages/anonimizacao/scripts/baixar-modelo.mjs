// Baixa o modelo NER para o cache local (dev: `pnpm anonimizacao:modelo`;
// imagem: roda na build para o container subir sem rede ao Hugging Face).
// Env: ANONIMIZACAO_MODELOS_DIR (default: .modelos na RAIZ do repo, não no
// package — o server roda da raiz), ANONIMIZACAO_NER_MODELO.
import { resolve } from 'node:path';
import { env, pipeline } from '@huggingface/transformers';

const modelo =
  process.env.ANONIMIZACAO_NER_MODELO ?? 'Xenova/distilbert-base-multilingual-cased-ner-hrl';
env.cacheDir =
  process.env.ANONIMIZACAO_MODELOS_DIR ?? resolve(import.meta.dirname, '../../../.modelos');
env.allowRemoteModels = true;

console.log(`baixando ${modelo} para ${env.cacheDir}…`);
const t0 = Date.now();
const pipe = await pipeline('token-classification', modelo, { dtype: 'q8' });
const saida = await pipe('Falei com o Carlos Eduardo Pereira ontem.', { ignore_labels: [] });
const pessoas = saida.filter((t) => /PER$/.test(t.entity)).map((t) => t.word);
console.log(`ok em ${((Date.now() - t0) / 1000).toFixed(1)}s — PER: ${pessoas.join(' ')}`);
