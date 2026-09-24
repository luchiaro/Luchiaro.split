// sw.js — Luchiaro.splitt
// Service worker : app shell minimal + interception du Web Share Target.

const CACHE_NAME = 'luchiaro-splitt-v1';
const SHARE_TARGET_PATH = '/share-target/';
const DB_NAME = 'luchiaro-share';
const DB_VERSION = 1;
const STORE_NAME = 'shared-images';

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json'
];

// ---------- Cycle de vie ----------

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {
        // Si l'app shell ne peut pas être mise en cache (ex: hors-ligne au premier
        // install), on laisse le SW s'installer quand même — il fonctionnera en
        // mode réseau pur tant que le cache n'est pas rempli.
      })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ---------- IndexedDB (stockage natif, sans librairie) ----------

function openShareDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) {
      reject(new Error('IndexedDB indisponible dans ce navigateur'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeSharedFiles(formData) {
  const db = await openShareDB();
  const files = formData.getAll('images');

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    let added = 0;
    for (const file of files) {
      // Garde-fou : certains navigateurs (dont d'anciennes versions iOS Safari)
      // peuvent transmettre une entrée vide ou tronquer un média trop lourd —
      // on ignore silencieusement ce qui n'est pas exploitable plutôt que de
      // planter tout le flux de partage.
      if (file && typeof file === 'object' && file.size > 0) {
        store.add({
          blob: file,
          name: file.name || 'image-partagee',
          type: file.type || 'image/png',
          ts: Date.now()
        });
        added++;
      }
    }

    tx.oncomplete = () => resolve(added);
    tx.onerror = () => reject(tx.error);
  });

  db.close();
}

// ---------- Interception réseau ----------

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Web Share Target : POST multipart -> IndexedDB -> redirection vers l'accueil
  if (event.request.method === 'POST' && url.pathname === SHARE_TARGET_PATH) {
    event.respondWith(handleShareTarget(event.request));
    return;
  }

  // App shell : cache d'abord, réseau en repli, pour les requêtes GET simples
  if (event.request.method === 'GET') {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        return (
          cached ||
          fetch(event.request).catch(() => cached)
        );
      })
    );
  }
});

async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    await storeSharedFiles(formData);
  } catch (err) {
    // On avale l'erreur volontairement : payload trop lourd, IndexedDB
    // indisponible, ou limitation historique d'iOS sur le partage de médias
    // vers une PWA. Dans tous les cas, l'utilisateur retombe sur l'accueil
    // et peut toujours déposer son image manuellement.
  }
  return Response.redirect('/', 303);
}
