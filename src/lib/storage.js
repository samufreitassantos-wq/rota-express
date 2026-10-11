// Persistência simples no localStorage do aparelho (nada é enviado a servidores próprios).
const PREFIX = 'rx.';

export function load(name, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + name);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function save(name, value) {
  try {
    localStorage.setItem(PREFIX + name, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(name) {
  try { localStorage.removeItem(PREFIX + name); } catch { /* ignore */ }
}
