/* Service worker: deja la app disponible sin conexión y recibe archivos compartidos desde otras apps. */
const VERSION = 'caja-chica-1.0.1';
const ARCHIVOS = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'logo.svg', 'logo-simbolo.svg',
  'js/db.js', 'js/escaner.js', 'js/pdf.js', 'js/api.js', 'js/app.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/atajo-escanear-96.png'
];

importScripts('js/db.js');

self.addEventListener('install', e => {
  // cache: 'reload' evita guardar copias viejas de la caché HTTP en la versión nueva
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ARCHIVOS.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(claves => Promise.all(claves.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/compartir')) {
    e.respondWith(recibirCompartido(e.request));
    return;
  }
  // Solo los archivos de la app: el servidor de Google (script.google.com) va siempre directo.
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
});

async function recibirCompartido(pedido) {
  try {
    const datos = await pedido.formData();
    const archivos = datos.getAll('archivos').filter(f => f && f.size);
    await DB.guardar('compartidos', 'ultimo', archivos.map(f => ({ nombre: f.name, tipo: f.type, blob: f })));
  } catch (e) {
    /* si falla, la app abre igual en el inicio */
  }
  return Response.redirect('./?compartido=1', 303);
}
