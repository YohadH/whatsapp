/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // HeyIL brand — Signal blue (#1A69F5): primary action + links.
        brand: {
          50: '#eef4ff',
          100: '#d9e6ff',
          200: '#b3cdff',
          300: '#7ea8ff',
          400: '#4785fb',
          500: '#1A69F5',
          600: '#1257d6',
          700: '#0f47ad',
          800: '#123c8a',
          900: '#14356e',
        },
        // HeyIL accent — Warm pink (#F7A8C8): used sparingly for highlights.
        accent: {
          50: '#fef1f6',
          100: '#fde4ee',
          200: '#fbc9dd',
          300: '#F7A8C8',
          400: '#f286b0',
          500: '#e85f93',
          600: '#d13f76',
          700: '#ad2f5e',
        },
        // Ink (#1C1C1E): text, "Hey", dark shell.
        ink: {
          800: '#2a2a2e',
          900: '#1C1C1E',
          950: '#121214',
        },
      },
      backgroundImage: {
        // Signature gradient: Signal blue → violet → Warm pink. Decorative only
        // (separators, wordmark) — never as text on a colored button.
        heyil: 'linear-gradient(120deg, #1A69F5 0%, #7B5CF0 50%, #F7A8C8 100%)',
        'heyil-soft': 'linear-gradient(120deg, #1A69F5 0%, #F7A8C8 100%)',
        // Dark shell (sidebar/login): Ink with a faint blue wash.
        'heyil-dark': 'linear-gradient(165deg, #1C1C1E 0%, #17171b 55%, #141d33 100%)',
      },
      fontFamily: {
        sans: ['Heebo', 'Segoe UI', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
