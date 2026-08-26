import type { Metadata } from 'next';
import './globals.css';
import { Geist } from 'next/font/google';
import { cn } from '@/lib/utils';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'SETA Console',
  description: 'Console de atendimento do agente SETA',
};

// tipo explícito em vez do global LayoutProps: o global é gerado em .next/types
// pelo next dev/build e não existe quando o typecheck roda antes do build (CI)
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={cn('h-full antialiased', 'font-sans', geist.variable)}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
