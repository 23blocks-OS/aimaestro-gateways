import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        terminal: {
          bg: '#1e1e1e',
          fg: '#d4d4d4',
          selection: '#264f78',
          cursor: '#aeafad',
        },
        sidebar: {
          bg: '#252526',
          hover: '#2a2d2e',
          active: '#37373d',
          border: '#3e3e42',
        },
      },
      fontFamily: {
        sans: ['Space Grotesk', 'system-ui', 'sans-serif'],
        mono: ['SF Mono', 'Monaco', 'Cascadia Code', 'Roboto Mono', 'Consolas', 'Courier New', 'monospace'],
      },
    },
  },
  plugins: [],
}
export default config
