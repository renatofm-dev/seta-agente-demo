import { loadClientConfig } from '@seta/client-config';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const clientConfig = loadClientConfig(env.CLIENT_CONFIG_PATH);
const app = buildApp({ env, clientConfig });

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info({ cliente: clientConfig.nome }, 'server no ar');
} catch (err) {
  app.log.error(err, 'falha no boot');
  process.exit(1);
}
