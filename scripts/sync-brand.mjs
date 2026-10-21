import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_NAME, SITE } from '../public/config/site.js';

const escape = text => String(text).replace(/[&"<>]/g, char => ({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'}[char]));

/** Keep the static share identity and initial HTML aligned with the runtime config. */
export async function syncBrand(root = fileURLToPath(new URL('../', import.meta.url)), { write = true } = {}) {
  const filename = path.join(root, 'public/index.html');
  const before = await fs.readFile(filename, 'utf8');
  let html = before.replace(/<title>[^<]*<\/title>/, `<title>${escape(BRAND_NAME)}</title>`);
  html = html.replace(/(<([a-z][a-z0-9-]*)\b[^>]*\bdata-brand\b[^>]*>)[^<]*(<\/\2>)/g, (_match, open, _tag, close) => `${open}${escape(BRAND_NAME)}${close}`);
  const canonical = new URL('/', SITE.canonical).href;
  const shareImage = new URL('/assets/brand/share-card.png?v=cube-1', canonical).href;
  const metadata = [
    ['name', 'description', SITE.brand.description],
    ['name', 'application-name', BRAND_NAME],
    ['property', 'og:title', BRAND_NAME],
    ['property', 'og:description', SITE.brand.description],
    ['property', 'og:site_name', BRAND_NAME],
    ['property', 'og:url', canonical],
    ['property', 'og:image', shareImage],
    ['name', 'twitter:card', 'summary'],
    ['name', 'twitter:title', BRAND_NAME],
    ['name', 'twitter:description', SITE.brand.description],
    ['name', 'twitter:image', shareImage],
  ];
  for (const [attribute, key, value] of metadata) {
    const expression = new RegExp(`<meta ${attribute}="${key}"[^>]*>`);
    const tag = `<meta ${attribute}="${key}" content="${escape(value)}">`;
    html = expression.test(html) ? html.replace(expression, tag) : html.replace('</head>', `${tag}</head>`);
  }
  const canonicalTag = `<link rel="canonical" href="${escape(canonical)}">`;
  html = /<link\b[^>]*rel="canonical"[^>]*>/.test(html)
    ? html.replace(/<link\b[^>]*rel="canonical"[^>]*>/, canonicalTag)
    : html.replace('</head>', `${canonicalTag}</head>`);
  if (write && html !== before) await fs.writeFile(filename, html);
  return { brand: BRAND_NAME, matches: before === html, metadata: metadata.map(([, key]) => key) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await syncBrand()));
}
