import { defineConfig } from 'vite';

// base relativa: funciona tanto em domínio próprio quanto em GitHub Pages (/rota-express/).
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  test: { include: ['tests/**/*.test.js'] },
});
