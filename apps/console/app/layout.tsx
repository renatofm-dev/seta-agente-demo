import type { Metadata } from 'next';
import './globals.css';
import { DM_Sans, JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import { cn } from '@/lib/utils';

// Tipografia do design (Console SETA.dc.html): DM Sans no corpo, Space Grotesk
// em títulos e números grandes, JetBrains Mono em códigos, horários e rótulos.
const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
});
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-heading',
});
const jetBrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'SETA.IA · Console',
  description: 'Console de operação: atendimento e campanhas de cobrança no WhatsApp',
};

// tipo explícito em vez do global LayoutProps: o global é gerado em .next/types
// pelo next dev/build e não existe quando o typecheck roda antes do build (CI)
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="pt-BR"
      className={cn(
        'h-full antialiased',
        dmSans.variable,
        spaceGrotesk.variable,
        jetBrainsMono.variable,
      )}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
