import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Social Video Studio',
  description: 'Create polished social videos with AI-generated footage, voiceover, captions and editing.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0B0B10' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
