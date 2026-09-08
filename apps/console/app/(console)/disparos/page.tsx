import { redirect } from 'next/navigation';

/** Disparos (013) viraram Campanhas no design; a rota antiga só redireciona. */
export default function DisparosRedirect() {
  redirect('/campanhas');
}
