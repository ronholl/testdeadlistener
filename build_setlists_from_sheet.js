#!/usr/bin/env node
/*
  Build data/setlists/*.json from the live Google Sheet catalog.

  Usage:
    node build_setlists_from_sheet.js
    node build_setlists_from_sheet.js --mode "Jerry Garcia"
    node build_setlists_from_sheet.js --merge-export localStorage-export.json
    node build_setlists_from_sheet.js --mode "Jerry Garcia" --dry-run

  The sheet Archive ID is authoritative. Existing static JSON and optional local
  delta/export files are used first, then archive.org metadata is fetched for any
  Archive IDs that are still missing.
*/
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, 'data', 'setlists');
const INDEX_HTML = path.join(ROOT, 'index.html');
const APP_SCRIPT_URL = extractConst('SCRIPT_URL');
const MODE_FILES = {
  gd: 'grateful-dead.json',
  'jerry-garcia': 'jerry-garcia.json',
  'phil-lesh': 'phil-lesh.json',
  'bob-weir': 'bob-weir.json'
};
const DELTA_KEYS = {
  gd: ['gd_setlist_delta', 'gd_setlists'],
  'jerry-garcia': ['gd_setlist_delta_jerry-garcia', 'gd_setlists_jerry-garcia'],
  'phil-lesh': ['gd_setlist_delta_phil-lesh', 'gd_setlists_phil-lesh'],
  'bob-weir': ['gd_setlist_delta_bob-weir', 'gd_setlists_bob-weir']
};
const SKIP_EXISTING = process.argv.includes('--skip-existing');
const DRY_RUN = process.argv.includes('--dry-run');
const ONLY_MODE = argValue('--mode');
const MERGE_EXPORT = argValue('--merge-export');

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : '';
}

function extractConst(name) {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const re = new RegExp("const\\s+" + name + "\\s*=\\s*'([^']+)'");
  const match = html.match(re);
  if (!match) throw new Error(`Could not find ${name} in index.html`);
  return match[1];
}

function modeKey(label) {
  const s = String(label || '').trim().toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'mode';
}

function normalizeArchiveId(value) {
  return String(value || '')
    .trim()
    .replace(/^archive:/i, '')
    .replace(/^https?:\/\/archive\.org\/(?:details|download)\//i, '')
    .split(/[/?#]/)[0]
    .trim();
}

function isBuildableArchiveId(value) {
  const id = normalizeArchiveId(value);
  return !!id && id.toUpperCase() !== 'NO_AUDIO';
}

function cleanSong(value) {
  return String(value || '')
    .replace(/\.(mp3|flac|shn|ogg|m4a|wav)$/i, '')
    .replace(/\b(vbr|64kb|128kb|soundboard|audience|matrix|remaster)\b/ig, '')
    .replace(/^(?:bwb?|weir)\d{4}[-_. ]\d{2}[-_. ]\d{2}[a-z]*[-_. ]*(?:[a-z]+[-_. ]*)?\d{1,2}[-_. ]*/i, '')
    .replace(/^(?:bwb?|weir)\d{2}[-_. ]\d{2}[-_. ]\d{2}[a-z]*[-_. ]*t\d+[-_. ]*/i, '')
    .replace(/^(?:bwb?|weir)\d{4}[-_. ]\d{2}[-_. ]\d{2}[a-z]*[-_. ]*t\d+[-_. ]*/i, '')
    .replace(/^\s*\d+[\s.)_-]+/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanSongs(values) {
  const out = [];
  (Array.isArray(values) ? values : []).forEach(value => {
    const song = cleanSong(value);
    if (!song || song.length < 3 || /^\d+$/.test(song)) return;
    if (/^(track|disc|set|tuning|banter|crowd|intro|outro)\s*\d*$/i.test(song)) return;
    out.push(song);
  });
  return out.slice(0, 80);
}

function descriptionText(value) {
  return String(Array.isArray(value) ? value.join('\n') : (value || ''))
    .replace(/<br\s*\/?>/ig, '\n')
    .replace(/<\/p>|<\/div>|<\/li>/ig, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&nbsp;/g, ' ');
}

function songsFromDescription(rawDescription) {
  const text = descriptionText(rawDescription);
  const out = [];
  function addTitle(value) {
    let title = String(value || '')
      .replace(/\s*(?:>|-&gt;)\s*$/g, '')
      .replace(/\s*\[[^\]]+\]\s*$/g, '')
      .replace(/\s+\d{1,2}:\d{2}(?::\d{2})?\s*$/g, '')
      .replace(/\s*\*+\s*$/g, '')
      .trim();
    if (/^(~+\s*)?(tuning|tuning and intro|intro|banter|crowd|encore|encore break|set\s*\d*|early show|late show)(\s*~+)?$/i.test(title)) return;
    out.push(title);
  }
  text.split(/\n+/).forEach(line => {
    const trackLine = line.match(/^\s*(?:disc\s*)?\d?\s*(?:d\d+t\d+|s\d+t\d+|t\d+|\d{1,2})\s*(?:[-:.)]|\s{2,}|\s)+(.+?)\s*$/i);
    if (trackLine) addTitle(trackLine[1]);
    const pieces = Array.from(line.matchAll(/(?:^|\s{2,})(?:d\d+t\d+|s\d+t\d+|t\d+|\d{1,2})\s+(.+?)(?=\s{2,}(?:d\d+t\d+|s\d+t\d+|t\d+|\d{1,2})\s+|$)/ig));
    if (pieces.length > 1) pieces.forEach(match => addTitle(match[1]));
  });
  if (out.length < 3) {
    const firstBlock = text
      .split(/\b(?:recording info|source|transfer|lineage|bob weir\s+-|notes?|addeddate|identifier|download options)\b/i)[0]
      .replace(/\bE\s*:/ig, ' ')
      .replace(/\bw\/[^,\n]+/ig, ' ')
      .trim();
    firstBlock.split(/\s{2,}|\n+|,+/).forEach(part => {
      part.split(/\s*>\s*/).forEach(addTitle);
    });
  }
  return cleanSongs(out.filter(song => {
    return !/\b(no setlist|unable to find|can anyone help|recording info|publication date|collection|band\/artist)\b/i.test(song);
  }));
}

function parseMaybeJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return {}; }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

function scriptUrl(params) {
  const url = new URL(APP_SCRIPT_URL);
  Object.keys(params || {}).forEach(key => url.searchParams.set(key, params[key]));
  return url.toString();
}

async function getModes() {
  const data = await fetchJson(scriptUrl({ action: 'getModes' }));
  return (data.modes || []).map(mode => ({
    key: mode.key || modeKey(mode.label),
    label: mode.label,
    sheetName: mode.sheetName,
    isDefault: !!mode.isDefault
  })).filter(mode => mode.label);
}

async function getCatalog(mode) {
  const data = await fetchJson(scriptUrl({ action: 'getCatalog', mode: mode.label }));
  if (data.error) throw new Error(`${mode.label}: ${data.error}`);
  return data;
}

function archiveRowsFromCatalog(catalog) {
  const byId = {};
  (catalog.shows || []).forEach(show => {
    const primary = normalizeArchiveId(show.archiveId);
    if (!isBuildableArchiveId(primary)) return;
    if (!byId[primary]) byId[primary] = [];
    byId[primary].push({
      date: show.date || '',
      venue: show.venue || '',
      city: show.city || '',
      row: show.row || '',
      archiveId: primary
    });
  });
  return byId;
}

function songsFromArchiveMetadata(meta) {
  const descSongs = songsFromDescription(meta && meta.metadata && meta.metadata.description);
  const files = (meta && meta.files) || [];
  const candidates = files
    .filter(file => {
      const name = String(file.name || '');
      if (!/\.(mp3|flac|shn|ogg|m4a|wav)$/i.test(name)) return false;
      if (/64kb|vbr|_thumb|spectrogram|checksums?/i.test(name)) return false;
      return true;
    })
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const names = candidates.map(file => file.title || file.name);
  const fileSongs = cleanSongs(names);
  if (descSongs.length >= 3 && descSongs.length >= Math.max(3, Math.floor(fileSongs.length / 2))) return descSongs;
  return fileSongs;
}

async function fetchArchiveSongs(archiveId) {
  try {
    const meta = await fetchJson(`https://archive.org/metadata/${encodeURIComponent(archiveId)}`);
    return songsFromArchiveMetadata(meta);
  } catch (e) {
    console.warn(`  ${archiveId}: ${e.message}`);
    return [];
  }
}

function mergeExportSetlists(target, mode, exported) {
  const keys = DELTA_KEYS[mode.key] || [];
  keys.forEach(key => {
    const cache = parseMaybeJson(exported[key]);
    Object.keys(cache || {}).sort().forEach(cacheKey => {
      if (!/^archive:/i.test(cacheKey)) return;
      const archiveId = normalizeArchiveId(cacheKey);
      const songs = cleanSongs(cache[cacheKey]);
      if (archiveId && songs.length) target[archiveId] = songs;
    });
  });
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function buildMode(mode, exported) {
  const catalog = await getCatalog(mode);
  const archiveRows = archiveRowsFromCatalog(catalog);
  const ids = Object.keys(archiveRows).sort();
  const outFile = MODE_FILES[mode.key] || `${mode.key}.json`;
  const outPath = path.join(OUT_DIR, outFile);
  const existing = readJson(outPath, {});
  const setlists = {};
  Object.keys(existing.setlists || {}).sort().forEach(id => {
    const archiveId = normalizeArchiveId(id);
    const songs = cleanSongs(existing.setlists[id]);
    if (archiveId && songs.length) setlists[archiveId] = songs;
  });
  mergeExportSetlists(setlists, mode, exported);

  const missing = ids.filter(id => !setlists[id] || !setlists[id].length);
  console.log(`${mode.label}: found ${ids.length} Archive IDs in sheet`);
  if (ids.length) console.log(`  first IDs: ${ids.slice(0, 5).join(', ')}`);
  console.log(`  already in JSON/export: ${ids.length - missing.length}`);
  console.log(`  need archive.org fetch: ${missing.length}`);
  if (DRY_RUN) {
    console.log(`  dry run only, not fetching or writing ${mode.label}`);
    return;
  }
  if (!SKIP_EXISTING && missing.length) {
    let foundCount = 0;
    await mapLimit(missing, 4, async (archiveId, idx) => {
      const songs = await fetchArchiveSongs(archiveId);
      if (songs.length) {
        foundCount++;
        setlists[archiveId] = songs;
      }
      if ((idx + 1) % 5 === 0 || idx === missing.length - 1) {
        console.log(`  checked ${idx + 1}/${missing.length}, found ${foundCount} setlists`);
      }
    });
  }

  const sorted = {};
  ids.forEach(id => {
    if (setlists[id] && setlists[id].length) sorted[id] = setlists[id];
  });
  const stillMissing = ids.filter(id => !sorted[id]);
  const missingPath = path.join(OUT_DIR, `missing-${outFile}`);
  if (stillMissing.length) {
    fs.writeFileSync(missingPath, JSON.stringify({
      mode: mode.label,
      modeKey: mode.key,
      updated: new Date().toISOString(),
      missing: stillMissing.map(id => ({
        archiveId: id,
        shows: archiveRows[id] || []
      }))
    }, null, 2) + '\n');
    console.log(`${mode.label}: missing report -> data/setlists/${path.basename(missingPath)}`);
  } else if (fs.existsSync(missingPath)) {
    fs.unlinkSync(missingPath);
  }
  const doc = {
    schemaVersion: 1,
    mode: mode.label,
    modeKey: mode.key,
    updated: new Date().toISOString(),
    setlists: sorted
  };
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');
  console.log(`${mode.label}: wrote ${Object.keys(sorted).length}/${ids.length} -> data/setlists/${outFile}`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const exported = MERGE_EXPORT ? readJson(MERGE_EXPORT, {}) : {};
  let modes = await getModes();
  if (ONLY_MODE) {
    const wanted = modeKey(ONLY_MODE);
    modes = modes.filter(mode => mode.key === wanted || mode.label.toLowerCase() === ONLY_MODE.toLowerCase());
    if (!modes.length) throw new Error(`Mode not found: ${ONLY_MODE}`);
  }
  for (const mode of modes) {
    await buildMode(mode, exported);
  }
}

main().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
