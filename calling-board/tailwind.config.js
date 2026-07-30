/** @type {import('tailwindcss').Config} */

// The board is styled with plain Tailwind grays and tints in a few hundred
// places, so dark mode is done by pointing those exact shades at CSS variables
// (see src/index.css) rather than sprinkling `dark:` on every element.
// Backgrounds, text and borders get their own variables because the same shade
// means opposite things in each channel: `bg-blue-700` is a button that keeps
// its colour, while `text-blue-700` is ink that has to go light.
const bg = (name) => `rgb(var(--bg-${name}) / <alpha-value>)`
const fg = (name) => `rgb(var(--fg-${name}) / <alpha-value>)`
const bd = (name) => `rgb(var(--bd-${name}) / <alpha-value>)`

const backgroundColor = {
  white: bg('white'),
  gray: {
    50: bg('gray-50'),
    100: bg('gray-100'),
    200: bg('gray-200'),
    300: bg('gray-300'),
    400: bg('gray-400'),
    900: bg('gray-900'),
  },
  slate: { 200: bg('slate-200') },
  blue: { 50: bg('blue-50'), 100: bg('blue-100') },
  indigo: { 100: bg('indigo-100') },
  red: { 50: bg('red-50'), 100: bg('red-100'), 200: bg('red-200') },
  green: { 50: bg('green-50'), 100: bg('green-100') },
  amber: { 50: bg('amber-50'), 100: bg('amber-100') },
  yellow: { 100: bg('yellow-100') },
}

const textColor = {
  gray: {
    300: fg('gray-300'),
    400: fg('gray-400'),
    500: fg('gray-500'),
    600: fg('gray-600'),
    700: fg('gray-700'),
    800: fg('gray-800'),
    900: fg('gray-900'),
  },
  slate: { 700: fg('slate-700') },
  blue: { 600: fg('blue-600'), 700: fg('blue-700'), 800: fg('blue-800') },
  red: { 700: fg('red-700'), 800: fg('red-800') },
  green: { 700: fg('green-700'), 800: fg('green-800'), 900: fg('green-900') },
  amber: { 700: fg('amber-700'), 800: fg('amber-800'), 900: fg('amber-900') },
  yellow: { 800: fg('yellow-800') },
}

const borderColor = {
  gray: { 100: bd('gray-100'), 200: bd('gray-200'), 300: bd('gray-300') },
  blue: { 100: bd('blue-100'), 200: bd('blue-200'), 300: bd('blue-300') },
  red: { 200: bd('red-200') },
  green: { 200: bd('green-200') },
  amber: { 200: bd('amber-200'), 300: bd('amber-300') },
}

export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      backgroundColor,
      textColor,
      borderColor,
      // The sign-in pages wash the whole screen in a gradient, which reads from
      // gradientColorStops rather than backgroundColor.
      gradientColorStops: {
        blue: { 50: bg('blue-50') },
        indigo: { 100: bg('indigo-100') },
      },
      ringColor: {
        gray: { 300: bd('gray-300') },
      },
    },
  },
  plugins: [],
}
