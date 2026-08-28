import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { newTraceId } from '@seta/observability';
import { parseSkillMd } from '@seta/skills';
import { eq, eq as eqSkill } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createAuth } from './auth.js';
import { createDb, type Db } from './db/index.js';
import { contato, skill as skillTable, user } from './db/schema.js';
import { loadEnv } from './env.js';
import { createPgVectorStore } from './rag/pgvector-store.js';
import { createSkillRegistry } from './skills/registry.js';
import { loadVinculos } from './wa/vinculo.js';

/**
 * Seed do banco `app` (007), idempotente:
 * - vínculos contato↔cliente do configs/demo/contatos.yaml → tabela `contato`
 *   (corte da 000: verificação pré-vinculada por seed);
 * - 1 usuário `atendente` e 1 `curador` no Better Auth.
 */

export const USUARIOS_DEMO = [
  {
    email: 'atendente@demo.seta',
    password: 'atendente-demo-123',
    name: 'Ana Atendente',
    role: 'atendente' as const,
  },
  {
    email: 'curador@demo.seta',
    password: 'curador-demo-123',
    name: 'Caio Curador',
    role: 'curador' as const,
  },
];

export async function seedApp(db: Db, env: ReturnType<typeof loadEnv>): Promise<void> {
  // paths relativos da env são relativos à RAIZ do monorepo (dist/ = apps/server/dist)
  const contatosPath = isAbsolute(env.CONTATOS_PATH)
    ? env.CONTATOS_PATH
    : resolve(join(import.meta.dirname, '../../..'), env.CONTATOS_PATH);
  const vinculos = loadVinculos(contatosPath);
  for (const [waId, clienteErpId] of vinculos) {
    await db
      .insert(contato)
      .values({ id: newTraceId(), waId, clienteErpId, verificadoEm: new Date() })
      .onConflictDoUpdate({ target: contato.waId, set: { clienteErpId } });
  }

  // 2 skills escritos à mão (009) — prova do formato SKILL.md
  const dirSkills = isAbsolute(env.SKILLS_SEED_DIR)
    ? env.SKILLS_SEED_DIR
    : resolve(join(import.meta.dirname, '../../..'), env.SKILLS_SEED_DIR);
  const store = createPgVectorStore({ db, dim: env.EMBEDDING_DIM });
  const registry = createSkillRegistry({ db, store, embed: null });
  for (const arquivo of readdirSync(dirSkills).filter((f) => f.endsWith('.md'))) {
    const doc = parseSkillMd(readFileSync(join(dirSkills, arquivo), 'utf-8'));
    const [existente] = await db
      .select()
      .from(skillTable)
      .where(eqSkill(skillTable.idLogico, doc.frontmatter.name));
    if (existente) continue; // idempotente
    await registry.criarSkillComVersaoAtiva(doc, 'humano');
  }

  const auth = createAuth(db, { secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL });
  for (const u of USUARIOS_DEMO) {
    try {
      await auth.api.signUpEmail({ body: { email: u.email, password: u.password, name: u.name } });
    } catch {
      // usuário já existe (idempotência)
    }
    await db.update(user).set({ role: u.role }).where(eq(user.email, u.email));
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, close } = createDb(env.DATABASE_URL);
  try {
    await migrate(db, { migrationsFolder: join(import.meta.dirname, '../drizzle') });
    await seedApp(db, env);
    console.log(
      `seed app ok: ${USUARIOS_DEMO.map((u) => `${u.email} (${u.role})`).join(', ')} + vínculos de contatos.yaml`,
    );
  } finally {
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
