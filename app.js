'use strict';
/* Tonies-Sammler – privat, offline. Daten liegen lokal in IndexedDB (dieses Gerät). */

const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());   // läuft als Android-App
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const norm = s => (s || '').toLowerCase().replace(/ß/g, 'ss').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const de = new Intl.Collator('de', {sensitivity: 'base', numeric: true});

const TABS = [
  {id: 'besitz', label: 'Im Besitz'},
  {id: 'alle', label: 'Alle Tonies'},
  {id: 'raritaet', label: 'Raritäten'},
  {id: 'bald', label: 'Bald Raritäten'},
];
const STATUS = {aktuell: 'Aktuell', letzte_chance: 'Bald Rarität', raritaet: 'Rarität'};
const QUELLE = {shop: 'Tonies-Shop', support: 'Liste „nicht mehr verfügbar“', manuell: 'Selbst angelegt'};
const ACCENTS = [['#1f7a6b', 'Petrol'], ['#2f6fdd', 'Blau'], ['#e0731d', 'Orange'], ['#d6457a', 'Rosa'], ['#7a4fd1', 'Violett'], ['#3f8f3a', 'Grün']];
const BGS = [['#f6f4ef', 'Hell'], ['#fbf1de', 'Creme'], ['#e8f3ee', 'Mint'], ['#e8f0f8', 'Himmel'], ['#171b1e', 'Dunkel'], ['#000000', 'Schwarz']];

/* ---------- lokale Datenbank ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('tonies-sammler', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('tonies', {keyPath: 'id'});
        d.createObjectStore('besitz');
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  store(n, mode = 'readonly') { return this.db.transaction(n, mode).objectStore(n); },
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  all(n) { return this.req(this.store(n).getAll()); },
  keys(n) { return this.req(this.store(n).getAllKeys()); },
  put(n, v, k) { const s = this.store(n, 'readwrite'); return this.req(k === undefined ? s.put(v) : s.put(v, k)); },
  del(n, k) { return this.req(this.store(n, 'readwrite').delete(k)); },
  putMany(n, items) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(n, 'readwrite');
      items.forEach(i => t.objectStore(n).put(i));
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  },
};

/* ---------- Zustand ---------- */
const S = {tonies: [], byId: new Map(), besitz: new Set(), tab: 'alle', group: 'none', art: '', q: '', closed: new Set(), urls: new Map()};
const settings = {accent: ACCENTS[0][0], bg: BGS[0][0]};
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ohne Speicher weiterlaufen */ } };

function prep(t) { t.key = norm(`${t.serie} ${t.titel}`); return t; }
function label(t) { return t.serie ? `${t.serie} - ${t.titel}` : t.titel; }

function imgSrc(t) {
  if (t.bild instanceof Blob) {
    const c = S.urls.get(t.id);
    if (c && c.blob === t.bild) return c.url;
    if (c) URL.revokeObjectURL(c.url);
    const url = URL.createObjectURL(t.bild);
    S.urls.set(t.id, {blob: t.bild, url});
    return url;
  }
  return placeholder(t);
}
function placeholder(t) {   // Platzhalter, bis ein Bild vorhanden ist: eigene Figur-Silhouette, Farbe je Serie
  let h = 0; for (const ch of t.serie || t.titel) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const letter = esc((t.serie || t.titel || '?').trim().charAt(0).toUpperCase());
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 90"><rect width="120" height="90" fill="hsl(${h} 45% 93%)"/>` +
    `<ellipse cx="60" cy="74" rx="28" ry="7" fill="hsl(${h} 35% 78%)"/><rect x="40" y="30" width="40" height="44" rx="15" fill="hsl(${h} 50% 62%)"/>` +
    `<circle cx="60" cy="24" r="14" fill="hsl(${h} 55% 72%)"/><text x="60" y="61" font-family="sans-serif" font-size="22" font-weight="700" text-anchor="middle" fill="#fff">${letter}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

/* ---------- Filter & Gruppen ---------- */
const tabTest = {
  besitz: t => S.besitz.has(t.id),
  alle: () => true,
  raritaet: t => t.status === 'raritaet',
  bald: t => t.status === 'letzte_chance',
};
function cmp(a, b) { return de.compare(a.serie || a.titel, b.serie || b.titel) || de.compare(a.titel, b.titel); }
function visible() {
  let l = S.tonies.filter(tabTest[S.tab]);
  if (S.art) l = l.filter(t => (t.gruppe || 'Sonstige') === S.art);
  const q = norm(S.q);
  if (q) l = l.filter(t => q.split(' ').every(w => t.key.includes(w)));
  return l.sort(cmp);
}
function groupOf(t) {
  switch (S.group) {
    case 'serie': return t.serie || '(ohne Serie)';
    case 'status': return STATUS[t.status] || t.status;
    case 'art': return t.gruppe || 'Sonstige';
    case 'besitz': return S.besitz.has(t.id) ? 'Im Besitz' : 'Nicht im Besitz';
    case 'buchstabe': { const c = (t.serie || t.titel).trim().charAt(0).toUpperCase(); return /[A-ZÄÖÜ]/.test(c) ? c : '#'; }
    default: return '';
  }
}
const GROUP_ORDER = {status: ['Aktuell', 'Bald Rarität', 'Rarität'], besitz: ['Im Besitz', 'Nicht im Besitz']};

/* ---------- Anzeige ---------- */
function renderTabs() {
  const nav = $('#tabs');
  nav.innerHTML = TABS.map(tb => {
    const items = S.tonies.filter(tabTest[tb.id]);
    const marked = items.filter(t => t.markierung);
    const dot = marked.length ? `<span class="dot ${marked.some(t => t.markierung === 'pruefen') ? 'pruefen' : ''}" title="${marked.length} Neuheit(en)"></span>` : '';
    return `<button class="tab" role="tab" data-tab="${tb.id}" aria-selected="${S.tab === tb.id}">${tb.label}<small>${items.length}</small>${dot}</button>`;
  }).join('');
}
function renderArtFilter() {
  const arts = [...new Set(S.tonies.map(t => t.gruppe || 'Sonstige'))].sort(de.compare);
  const sel = $('#artFilter');
  sel.innerHTML = '<option value="">Alle</option>' + arts.map(a => `<option ${a === S.art ? 'selected' : ''}>${esc(a)}</option>`).join('');
}
function cardHtml(t) {
  const has = S.besitz.has(t.id);
  const pill = t.status === 'raritaet' ? '<span class="pill">Rarität</span>' : t.status === 'letzte_chance' ? '<span class="pill bald">Bald Rarität</span>' : '';
  const flag = t.markierung ? `<span class="flag ${t.markierung === 'pruefen' ? 'pruefen' : ''}">${{neu: 'Neu', status: 'Status neu', pruefen: 'Prüfen'}[t.markierung]}</span>` : '';
  const cap = t.serie ? `<b>${esc(t.serie)}</b> - ${esc(t.titel)}` : `<b>${esc(t.titel)}</b>`;
  return `<div class="card ${has ? 'has' : ''}" data-id="${esc(t.id)}" role="button" tabindex="0">` +
    `<div class="pic"><img loading="lazy" decoding="async" alt="" src="${imgSrc(t)}">${pill}${flag}` +
    `<button class="own" data-own="${esc(t.id)}" aria-label="Im Besitz umschalten" aria-pressed="${has}">✓</button></div>` +
    `<div class="cap">${cap}</div></div>`;
}
function renderList() {
  const main = $('#list');
  if (!S.tonies.length) {
    main.innerHTML = `<div class="empty"><h2>Noch kein Katalog</h2><p>Lies die Katalogdatei <b>katalog_export.json</b> ein oder lege Tonies selbst an.</p>` +
      `<p><button class="btn solid" data-act="import">Katalog aus Datei einlesen</button> ${NATIVE ? '' : '<button class="btn" data-act="server">Vom Server laden</button>'}</p></div>`;
    $('#count').textContent = '';
    return;
  }
  const list = visible();
  $('#count').textContent = `${list.length}/${S.tonies.filter(tabTest[S.tab]).length}`;
  if (!list.length) {
    main.innerHTML = `<div class="empty"><h2>Nichts gefunden</h2><p>${S.tab === 'besitz' && !S.besitz.size ? 'Du hast noch keine Tonies als „Im Besitz“ markiert.' : 'Für diese Auswahl gibt es keine Tonies.'}</p></div>`;
    return;
  }
  if (S.group === 'none') { main.innerHTML = `<div class="grid">${list.map(cardHtml).join('')}</div>`; return; }
  const groups = new Map();
  list.forEach(t => { const g = groupOf(t); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(t); });
  const order = GROUP_ORDER[S.group];
  const names = [...groups.keys()].sort((a, b) => order ? order.indexOf(a) - order.indexOf(b) : de.compare(a, b));
  main.innerHTML = names.map(g => {
    const closed = S.closed.has(S.group + '|' + g);
    return `<button class="ghead ${closed ? 'closed' : ''}" data-g="${esc(g)}"><span class="chev">▾</span>${esc(g)} <span class="n">(${groups.get(g).length})</span></button>` +
      (closed ? '' : `<div class="grid">${groups.get(g).map(cardHtml).join('')}</div>`);
  }).join('');
}
function render() { renderTabs(); renderArtFilter(); renderList(); $('#info').textContent = infoText(); }
function infoText() {
  const stand = load('stand', null);
  return `${S.tonies.length} Tonies, ${S.besitz.size} im Besitz.` + (stand ? ` Katalogstand: ${stand}.` : '');
}
function sizeHeader() { document.documentElement.style.setProperty('--headh', $('#top').offsetHeight + 'px'); }

function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------- Besitz ---------- */
async function toggleOwn(id) {
  if (S.besitz.has(id)) { S.besitz.delete(id); await DB.del('besitz', id); } else { S.besitz.add(id); await DB.put('besitz', true, id); }
  render();
  if (!$('#sheetWrap').hidden) openSheet(id, true);
}

/* ---------- Überlagerungen (Zurück-Taste schließt sie) ---------- */
const overlays = [];
let skipPop = 0;
function pushOverlay(name, closeFn) { overlays.push({name, closeFn}); history.pushState({o: name}, ''); }
window.addEventListener('popstate', () => {
  if (skipPop > 0) { skipPop--; return; }          // von uns ausgelöstes history.back()
  const o = overlays.pop(); if (o) o.closeFn();     // Zurück-Taste schließt die oberste Überlagerung
});
function closeOverlay(name) {
  const i = overlays.findIndex(o => o.name === name);
  if (i < 0) return;
  overlays.splice(i, 1)[0].closeFn();
  skipPop++; history.back();
}

function openSide() { $('#side').hidden = false; $('#scrim').hidden = false; pushOverlay('side', hideSide); }
function hideSide() { $('#side').hidden = true; $('#scrim').hidden = true; }
function closeSide() { closeOverlay('side'); }

/* ---------- Detailblatt ---------- */
function openSheet(id, refresh = false) {
  const t = S.byId.get(id); if (!t) return;
  const has = S.besitz.has(id);
  if (t.markierung) { delete t.markierung; DB.put('tonies', t); renderTabs(); }
  const preis = t.preis != null ? `${t.preis.toFixed(2).replace('.', ',')} €` : 'unbekannt';
  const hinw = (t.hinweise || []).map(h => `<div class="note">${esc(h)}</div>`).join('');
  $('#sheet').innerHTML =
    `<div class="big"><img alt="" src="${imgSrc(t)}">${t.status === 'raritaet' ? '<span class="pill">Rarität</span>' : t.status === 'letzte_chance' ? '<span class="pill bald">Bald Rarität</span>' : ''}</div>` +
    `<h2>${esc(t.titel)}</h2><p class="sub">${esc(t.serie || '')}</p>` +
    `<button class="ownbtn ${has ? 'on' : ''}" data-own="${esc(id)}">${has ? '✓ Im Besitz' : 'Als „Im Besitz“ markieren'}</button>` +
    hinw +
    `<div class="rows">` +
    `<div class="row"><span>Status</span><span>${STATUS[t.status] || esc(t.status)}</span></div>` +
    `<div class="row"><span>Originalpreis</span><span>${preis}</span></div>` +
    `<div class="row"><span>Art</span><span>${esc(t.gruppe || '–')}</span></div>` +
    `<div class="row"><span>Quelle</span><span>${QUELLE[t.quelle] || esc(t.quelle || '')}</span></div></div>` +
    `<div class="btnrow"><button class="btn" data-sheet="photo">${t.bild ? 'Bild ändern' : 'Bild hinzufügen'}</button>` +
    (t.quelle === 'manuell' ? `<button class="btn" data-sheet="edit">Bearbeiten</button><button class="btn danger" data-sheet="delete">Löschen</button>` : '') +
    `<button class="btn solid" data-sheet="close">Schließen</button></div>`;
  $('#sheet').dataset.id = id;
  if (!refresh) { $('#sheetWrap').hidden = false; pushOverlay('sheet', () => { $('#sheetWrap').hidden = true; }); }
}
const closeSheet = () => closeOverlay('sheet');

/* ---------- Bilder ---------- */
async function shrink(file, maxW = 480) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxW / bmp.width);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
}
async function setPhoto(id, file) {
  const t = S.byId.get(id); if (!t || !file) return;
  t.bild = await shrink(file); t.bildManuell = true;
  await DB.put('tonies', t); render(); if (!$('#sheetWrap').hidden) openSheet(id, true);
  toast('Bild gespeichert');
}
const blobToDataUrl = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
const dataUrlToBlob = u => fetch(u).then(r => r.blob());

/* ---------- Tonie anlegen / bearbeiten ---------- */
let editing = null;
function openForm(t) {
  editing = t || null;
  const f = $('#formEl'); f.reset();
  $('#formTitle').textContent = t ? 'Tonie bearbeiten' : 'Neuer Tonie';
  $('#serienListe').innerHTML = [...new Set(S.tonies.map(x => x.serie).filter(Boolean))].sort(de.compare).map(s => `<option value="${esc(s)}">`).join('');
  if (t) { f.serie.value = t.serie || ''; f.titel.value = t.titel; f.status.value = t.status; f.gruppe.value = t.gruppe || 'Einzelne Tonies'; f.preis.value = t.preis ?? ''; }
  $('#form').showModal();
}
async function submitForm(ev) {
  ev.preventDefault();
  const f = $('#formEl');
  const titel = f.titel.value.trim(); if (!titel) return;
  const t = editing || {id: 'man:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), quelle: 'manuell', hinweise: [], bildManuell: true};
  Object.assign(t, {serie: f.serie.value.trim(), titel, status: f.status.value, gruppe: f.gruppe.value, preis: f.preis.value ? parseFloat(f.preis.value) : null});
  const file = f.bild.files[0]; if (file) t.bild = await shrink(file);
  prep(t); await DB.put('tonies', t);
  if (!S.byId.has(t.id)) { S.tonies.push(t); S.byId.set(t.id, t); }
  $('#form').close(); render(); toast(editing ? 'Gespeichert' : 'Tonie angelegt');
}
async function deleteTonie(id) {
  const t = S.byId.get(id); if (!t || t.quelle !== 'manuell') return;
  if (!confirm(`„${label(t)}“ wirklich löschen?`)) return;
  await DB.del('tonies', id); await DB.del('besitz', id); S.besitz.delete(id);
  S.byId.delete(id); S.tonies = S.tonies.filter(x => x.id !== id);
  closeSheet(); render(); toast('Gelöscht');
}

/* ---------- Import / Export ---------- */
async function importCatalog(data) {
  if (!data || data.format !== 'tonies-katalog' || !Array.isArray(data.tonies)) throw new Error('Das ist keine Tonies-Katalogdatei.');
  const first = S.tonies.length === 0;
  let neu = 0, geaendert = 0, gleich = 0;
  const out = [];
  for (const e of data.tonies) {
    if (!e.id || !e.titel) continue;
    const bild = e.bild_daten ? await dataUrlToBlob(e.bild_daten) : null;
    let t = S.byId.get(e.id);
    if (!t) {
      t = {id: e.id, serie: e.serie || '', titel: e.titel, status: e.status, gruppe: e.gruppe || '', preis: e.preis ?? null, seite: e.seite || null,
           quelle: e.quelle || 'shop', hinweise: e.hinweise || [], bild, bildManuell: !!e.bildManuell || e.quelle === 'manuell'};
      if (!first) t.markierung = (t.hinweise.length ? 'pruefen' : 'neu');
      neu++;
    } else {
      const alt = JSON.stringify([t.serie, t.titel, t.status, t.gruppe, t.preis, t.hinweise]);
      if (t.status !== e.status && t.quelle !== 'manuell') t.markierung = 'status';
      else if ((e.hinweise || []).length && JSON.stringify(e.hinweise) !== JSON.stringify(t.hinweise)) t.markierung = 'pruefen';
      if (t.quelle !== 'manuell' || e.quelle === 'manuell') {
        Object.assign(t, {serie: e.serie || '', titel: e.titel, status: e.status, gruppe: e.gruppe || t.gruppe, preis: e.preis ?? t.preis, seite: e.seite || t.seite, hinweise: e.hinweise || []});
      }
      const gleichesBild = !bild || (t.bild instanceof Blob && t.bild.size === bild.size);
      if (!gleichesBild && (!t.bildManuell || e.bildManuell)) { t.bild = bild; if (e.bildManuell) t.bildManuell = true; }
      alt === JSON.stringify([t.serie, t.titel, t.status, t.gruppe, t.preis, t.hinweise]) && gleichesBild ? gleich++ : geaendert++;
    }
    prep(t); out.push(t);
  }
  await DB.putMany('tonies', out);
  out.forEach(t => { if (!S.byId.has(t.id)) S.tonies.push(t); S.byId.set(t.id, t); });
  if (data.stand) save('stand', data.stand);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  render();
  toast(`Eingelesen: ${neu} neu, ${geaendert} geändert, ${gleich} unverändert`, 5000);
}
async function importFile(file) {
  try { await importCatalog(JSON.parse(await file.text())); }
  catch (e) { toast('Fehler: ' + (e.message || e), 6000); }
}
async function loadFromServer() {
  try {
    const r = await fetch('katalog_export.json', {cache: 'no-store'});
    if (!r.ok) throw new Error('Auf dem Server liegt keine katalog_export.json.');
    toast('Lade Katalog …'); await importCatalog(await r.json());
  } catch (e) { toast(navigator.onLine ? (e.message || 'Fehler beim Laden') : 'Keine Internetverbindung – die App arbeitet mit den gespeicherten Daten.', 5000); }
}
async function download(name, text) {
  if (NATIVE) {   // WebView kann keine Downloads: Datei zwischenspeichern, dann Teilen-Dialog (Drive, Mail, „Speichern unter“ …)
    const {Filesystem, Share} = window.Capacitor.Plugins;
    const f = await Filesystem.writeFile({path: name, data: text, directory: 'CACHE', encoding: 'utf8'});
    await Share.share({title: name, url: f.uri, dialogTitle: 'Datei speichern oder senden'});
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type: 'application/json'})); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function exportLibrary() {
  toast('Exportiere …');
  const tonies = [];
  for (const t of S.tonies) {
    tonies.push({id: t.id, serie: t.serie, titel: t.titel, status: t.status, gruppe: t.gruppe, preis: t.preis, seite: t.seite, quelle: t.quelle,
                 hinweise: t.hinweise || [], bildManuell: !!t.bildManuell, bild_daten: t.bild instanceof Blob ? await blobToDataUrl(t.bild) : null});
  }
  const d = new Date().toISOString().slice(0, 10);
  try {
    await download(`tonies-bibliothek-${d}.json`, JSON.stringify({format: 'tonies-katalog', version: 1, stand: load('stand', d), tonies}));
    toast('Bibliothek exportiert (ohne Besitz-Markierung)');
  } catch (e) { toast('Export abgebrochen: ' + (e.message || e), 6000); }
}
async function exportOwn() {
  const d = new Date().toISOString().slice(0, 10);
  try {
    await download(`tonies-besitz-${d}.json`, JSON.stringify({format: 'tonies-besitz', version: 1, ids: [...S.besitz]}));
    toast(S.besitz.size === 1 ? "1 Eintrag gesichert" : `${S.besitz.size} Einträge gesichert`);
  } catch (e) { toast('Sichern abgebrochen: ' + (e.message || e), 6000); }
}
async function importOwn(file) {
  try {
    const d = JSON.parse(await file.text());
    if (d.format !== 'tonies-besitz') throw new Error('Das ist keine Besitz-Datei.');
    const ids = d.ids.filter(id => S.byId.has(id));
    for (const id of ids) { S.besitz.add(id); await DB.put('besitz', true, id); }
    render(); toast(`${ids.length} Tonies als „Im Besitz“ übernommen` + (ids.length < d.ids.length ? ` (${d.ids.length - ids.length} nicht im Katalog)` : ''), 5000);
  } catch (e) { toast('Fehler: ' + (e.message || e), 6000); }
}
async function markAllSeen() {
  const m = S.tonies.filter(t => t.markierung); m.forEach(t => delete t.markierung);
  await DB.putMany('tonies', m); render(); toast(m.length ? `${m.length} als gesehen markiert` : 'Keine Neuheiten offen');
}

/* ---------- Darstellung ---------- */
function lum(hex) { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; }
function applySettings() {
  const r = document.documentElement;
  r.style.setProperty('--accent', settings.accent); r.style.setProperty('--bg', settings.bg);
  r.dataset.theme = lum(settings.bg) < 0.45 ? 'dark' : 'light';
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = settings.bg;
  document.querySelectorAll('#accentRow .sw').forEach(b => b.setAttribute('aria-pressed', b.dataset.c === settings.accent));
  document.querySelectorAll('#bgRow .sw').forEach(b => b.setAttribute('aria-pressed', b.dataset.c === settings.bg));
}
function buildSwatches() {
  $('#accentRow').innerHTML = ACCENTS.map(([c, n]) => `<button class="sw" data-k="accent" data-c="${c}" style="background:${c}" aria-label="Akzent ${n}" aria-pressed="false"></button>`).join('');
  $('#bgRow').innerHTML = BGS.map(([c, n]) => `<button class="sw" data-k="bg" data-c="${c}" style="background:${c}" aria-label="Hintergrund ${n}" aria-pressed="false"></button>`).join('');
}

/* ---------- Ereignisse ---------- */
function act(name) {
  if (name === 'new') { closeSide(); setTimeout(() => openForm(null), 30); }
  else if (name === 'import') { closeSide(); $('#fileCatalog').click(); }
  else if (name === 'server') { closeSide(); loadFromServer(); }
  else if (name === 'export') { closeSide(); exportLibrary(); }
  else if (name === 'seen') { closeSide(); markAllSeen(); }
  else if (name === 'ownexport') { closeSide(); exportOwn(); }
  else if (name === 'ownimport') { closeSide(); $('#fileOwn').click(); }
}
function bind() {
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b) { S.tab = b.dataset.tab; save('tab', S.tab); render(); window.scrollTo(0, 0); } });
  $('#groupBy').addEventListener('change', e => { S.group = e.target.value; save('group', S.group); renderList(); });
  $('#artFilter').addEventListener('change', e => { S.art = e.target.value; renderList(); });
  $('#search').addEventListener('input', e => { S.q = e.target.value; renderList(); });
  $('#menuBtn').addEventListener('click', openSide);
  $('#sideClose').addEventListener('click', closeSide);
  $('#scrim').addEventListener('click', closeSide);
  $('#side').addEventListener('click', e => {
    const a = e.target.closest('[data-act]'); if (a) return act(a.dataset.act);
    const sw = e.target.closest('.sw'); if (sw) { settings[sw.dataset.k] = sw.dataset.c; save('settings', settings); applySettings(); }
  });
  $('#list').addEventListener('click', e => {
    const a = e.target.closest('[data-act]'); if (a) return act(a.dataset.act);
    const own = e.target.closest('[data-own]'); if (own) { e.stopPropagation(); return toggleOwn(own.dataset.own); }
    const g = e.target.closest('.ghead'); if (g) { const k = S.group + '|' + g.dataset.g; S.closed.has(k) ? S.closed.delete(k) : S.closed.add(k); return renderList(); }
    const c = e.target.closest('.card'); if (c) openSheet(c.dataset.id);
  });
  $('#list').addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('card')) { e.preventDefault(); openSheet(e.target.dataset.id); } });
  $('#sheetBack').addEventListener('click', closeSheet);
  $('#sheet').addEventListener('click', e => {
    const id = $('#sheet').dataset.id;
    const own = e.target.closest('[data-own]'); if (own) return toggleOwn(own.dataset.own);
    const s = e.target.closest('[data-sheet]'); if (!s) return;
    if (s.dataset.sheet === 'close') closeSheet();
    else if (s.dataset.sheet === 'photo') { $('#filePhoto').dataset.id = id; $('#filePhoto').click(); }
    else if (s.dataset.sheet === 'edit') { const t = S.byId.get(id); closeSheet(); setTimeout(() => openForm(t), 30); }
    else if (s.dataset.sheet === 'delete') deleteTonie(id);
  });
  $('#filePhoto').addEventListener('change', e => { const f = e.target.files[0]; if (f) setPhoto(e.target.dataset.id, f); e.target.value = ''; });
  $('#fileCatalog').addEventListener('change', e => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ''; });
  $('#fileOwn').addEventListener('change', e => { const f = e.target.files[0]; if (f) importOwn(f); e.target.value = ''; });
  $('#formEl').addEventListener('submit', submitForm);
  $('#formCancel').addEventListener('click', () => $('#form').close());
  window.addEventListener('resize', sizeHeader);
}

/* ---------- Start ---------- */
(async function start() {
  Object.assign(settings, load('settings', {}));
  S.tab = load('tab', 'alle'); S.group = load('group', 'none');
  if (NATIVE) document.querySelectorAll('[data-act=server]').forEach(b => b.remove());
  buildSwatches(); applySettings(); bind();
  $('#groupBy').value = S.group;
  try {
    await DB.open();
    S.tonies = (await DB.all('tonies')).map(prep);
    S.tonies.forEach(t => S.byId.set(t.id, t));
    (await DB.keys('besitz')).forEach(k => S.besitz.add(k));
  } catch (e) { toast('Lokaler Speicher nicht verfügbar: ' + e.message, 8000); }
  render(); sizeHeader();
  if (!NATIVE && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
