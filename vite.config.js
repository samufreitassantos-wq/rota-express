import { defineConfig, loadEnv } from 'vite';

/**
 * Content Security Policy (meta tag, pois o GitHub Pages não permite cabeçalhos HTTP).
 * Só no build: scripts apenas do próprio app (+ WebAssembly do OCR), conexões apenas para os
 * serviços usados. Reduz o impacto de qualquer XSS (script injetado não executa / não exfiltra).
 */
function csp(env) {
  let supabase = '';
  try {
    if (env.VITE_SUPABASE_URL) supabase = new URL(env.VITE_SUPABASE_URL).origin;
  } catch { /* URL inválida: nuvem fica desligada */ }
  const policy = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'", // Leaflet e barras de progresso usam style inline
    "img-src 'self' data: blob: https://tile.openstreetmap.org",
    `connect-src 'self' ${supabase} https://api.openrouteservice.org https://nominatim.openstreetmap.org`.replace(/\s+/g, ' '),
    "worker-src 'self' blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "manifest-src 'self'",
  ].join('; ');
  return {
    name: 'rota-express-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' }],
  };
}

// base relativa: funciona tanto em domínio próprio quanto em GitHub Pages (/rota-express/).
export default defineConfig(({ mode }) => ({
  base: './',
  build: { target: 'es2022' },
  plugins: [csp(loadEnv(mode, process.cwd(), 'VITE_'))],
  test: { include: ['tests/**/*.test.js'] },
}));
