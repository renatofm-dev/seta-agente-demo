import { notFound } from 'next/navigation';
import SimuladorClient from './simulador-client';

/** Simulador (004) atrás de flag dev (007): fora do ar em produção por padrão. */
export default function SimuladorPage() {
  const habilitado =
    process.env.NEXT_PUBLIC_DEV_SIMULATOR === 'true' ||
    (process.env.NEXT_PUBLIC_DEV_SIMULATOR === undefined && process.env.NODE_ENV !== 'production');
  if (!habilitado) notFound();
  return <SimuladorClient />;
}
