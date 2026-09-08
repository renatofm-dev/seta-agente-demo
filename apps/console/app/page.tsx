import { redirect } from 'next/navigation';

/** A raiz é o atendimento (007/#45); sem sessão, o layout do console manda para /login. */
export default function Home() {
  redirect('/inbox');
}
