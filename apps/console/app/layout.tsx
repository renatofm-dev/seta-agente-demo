import type { Metadata } from 'next';
import './globals.css';
import { Geist } from 'next/font/google';
import { cn } from '@/lib/utils';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'SETA Console',
  description: 'Console de atendimento do agente SETA',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="pt-BR" className={cn('h-full antialiased', 'font-sans', geist.variable)}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
