import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Prompt-base versionado em arquivo (packages/agent/prompts/), nunca string inline. */

const DIR = dirname(fileURLToPath(import.meta.url));

let cache: string | null = null;

export function renderPromptBase(vars: {
  persona: string;
  resumo: string | null;
  skills: readonly { id: string; conteudo: string }[];
}): string {
  if (cache === null) {
    cache = readFileSync(join(DIR, '../prompts/base.md'), 'utf-8');
  }
  const skillsTexto =
    vars.skills.length === 0
      ? '(nenhuma skill específica para este atendimento)'
      : vars.skills.map((s) => `### ${s.id}\n${s.conteudo}`).join('\n\n');
  return cache
    .replace('{{persona}}', vars.persona)
    .replace('{{resumo}}', vars.resumo?.trim() || '(conversa recém-iniciada, sem resumo)')
    .replace('{{skills}}', skillsTexto);
}
