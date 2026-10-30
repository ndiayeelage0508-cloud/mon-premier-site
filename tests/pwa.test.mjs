import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
const publicBase = new URL('https://ndiayeelage0508-cloud.github.io/mon-premier-site/');

function pngSize(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a', `${file} is PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('le manifeste définit une web app installable sous le chemin GitHub Pages', () => {
  assert.match(html, /<link\s+rel="manifest"\s+href="\.\/manifest\.webmanifest"\s*\/>/);
  assert.equal(manifest.name.startsWith('PromptLab'), true);
  assert.equal(manifest.short_name, 'PromptLab');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.lang, 'fr');
  assert.equal(manifest.theme_color, '#ffd21c');
  assert.equal(manifest.id, '/mon-premier-site/');
  assert.equal(new URL(manifest.id, publicBase).href, publicBase.href);
  assert.equal(new URL(manifest.start_url, publicBase).href, publicBase.href);
  assert.equal(new URL(manifest.scope, publicBase).href, publicBase.href);

  for (const [size, file] of [[192, 'icon-192.png'], [512, 'icon-512.png']]) {
    const icon = manifest.icons.find((entry) => entry.sizes === `${size}x${size}`);
    assert.ok(icon, `manifest declares ${size}x${size} icon`);
    assert.equal(icon.type, 'image/png');
    const resolved = new URL(icon.src, publicBase);
    assert.equal(resolved.pathname, `/mon-premier-site/icons/${file}`);
    assert.deepEqual(pngSize(path.join(root, 'icons', file)), { width: size, height: size });
  }
});

test('les métadonnées Apple et favicon pointent vers des icônes locales valides', () => {
  assert.match(html, /name="apple-mobile-web-app-capable"\s+content="yes"/);
  assert.match(html, /name="apple-mobile-web-app-title"\s+content="PromptLab"/);
  assert.match(html, /rel="apple-touch-icon"\s+sizes="180x180"\s+href="\.\/icons\/apple-touch-icon\.png"/);
  assert.deepEqual(pngSize(path.join(root, 'icons', 'apple-touch-icon.png')), { width: 180, height: 180 });
  assert.match(html, /rel="icon"\s+type="image\/svg\+xml"\s+href="\.\/favicon\.svg"/);
  assert.ok(fs.statSync(path.join(root, 'favicon.svg')).size > 0);
});

test('aucun service worker ni mécanisme de cache ne peut intercepter les données ou API', () => {
  const serviceWorkers = [];
  function findServiceWorkers(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) findServiceWorkers(full);
      else if (/^(sw|service-worker)(\.|-)/i.test(entry.name)) serviceWorkers.push(full);
    }
  }
  findServiceWorkers(root);
  assert.deepEqual(serviceWorkers, []);
  assert.doesNotMatch(`${html}\n${app}`, /navigator\.serviceWorker|serviceWorker\.register|caches\.open\s*\(/i);
  assert.match(app, /fetch\(apiPath\("\/api\/"\s*\+\s*requestedMode\)/);
});
