/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // HeyIL brand — Royal blue (#0054FC, from the house-logo): primary action + links.
        brand: {
          50: '#eef3ff',
          100: '#d8e4ff',
          200: '#b0ccff',
          300: '#7ca6ff',
          400: '#3e7bff',
          500: '#0054FC',
          600: '#0043d6',
          700: '#0036ad',
          800: '#0a2e8a',
          900: '#0f2a6e',
        },
        // HeyIL accent — Magenta (#EE03FD, the logo's roof ramp): used sparingly for highlights.
        accent: {
          50: '#fdf2ff',
          100: '#fbe3ff',
          200: '#f6c2ff',
          300: '#f09afe',
          400: '#ee5efd',
          500: '#e617f2',
          600: '#c50dce',
          700: '#9e0ba6',
        },
        // Ink (#1C1C1E): text, "Hey", dark shell.
        ink: {
          800: '#2a2a2e',
          900: '#1C1C1E',
          950: '#121214',
        },
      },
      backgroundImage: {
        // Signature gradient: Royal blue → violet → Magenta (the house-logo ramp).
        // Decorative only (separators, wordmark) — never as text on a colored button.
        heyil: 'linear-gradient(120deg, #0054FC 0%, #8504FD 50%, #EE03FD 100%)',
        'heyil-soft': 'linear-gradient(120deg, #0054FC 0%, #EE03FD 100%)',
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
