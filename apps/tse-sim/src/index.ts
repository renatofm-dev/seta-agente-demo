import { buildTseSimApp } from './app.js';
import { criarBanco } from './db.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const db = criarBanco(env.TSE_SIM_DATABASE_URL);
const app = buildTseSimApp({ env, db });

for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sinal, () => {
    void app
      .close()
      .then(() => db.fechar())
      .then(() => process.exit(0));
  });
}

await app.listen({ port: env.TSE_SIM_PORT, host: '0.0.0.0' });
app.log.info(
  { porta: env.TSE_SIM_PORT, escopo: env.TSE_SIM_PAINEL_ESCOPO },
  'simulador do TS Explorer no ar',
);
