/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // HeyIL brand — primary green (left of the logo).
        brand: {
          50: '#ecfdf5',
          100: '#d1fae5',
          200: '#a7f3d0',
          300: '#6ee7b7',
          400: '#34d399',
          500: '#10b981',
          600: '#059669',
          700: '#047857',
          800: '#065f46',
          900: '#064e3b',
        },
        // HeyIL accent — blue (right of the logo).
        accent: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
        },
        // Dark shell base (the logo's black canvas).
        ink: {
          800: '#0f1b2d',
          900: '#0a1420',
          950: '#060d16',
        },
      },
      backgroundImage: {
        // The signature HeyIL gradient: green → teal → blue (matches the logo wordmark).
        heyil: 'linear-gradient(120deg, #10b981 0%, #14b8a6 48%, #2563eb 100%)',
        'heyil-soft': 'linear-gradient(120deg, #10b981 0%, #2563eb 100%)',
        // Dark sidebar: near-black with a faint green→blue wash.
        'heyil-dark': 'linear-gradient(165deg, #0a1420 0%, #08211c 55%, #06243a 100%)',
      },
      fontFamily: {
        sans: ['Heebo', 'Segoe UI', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
