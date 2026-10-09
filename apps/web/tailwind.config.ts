import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        studio: {
          bg: '#0B0B10',
          panel: '#13131B',
          card: '#191923',
          line: '#2A2A38',
          muted: '#8B8BA3',
          accent: '#8B5CF6',
          accent2: '#EC4899',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['Montserrat', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(139,92,246,.35), 0 8px 30px -10px rgba(139,92,246,.45)',
      },
    },
  },
  plugins: [],
} satisfies Config;
