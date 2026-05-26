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
const OUT_DIR = path.resolve(argValue('--out-dir') || process.env.SETLIST_OUT_DIR || path.join(ROOT, 'data', 'setlists'));
const INDEX_HTML = path.join(ROOT, 'index.html');
const DEFAULT_APP_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzDkkn9PBWvmBFsjRpoj0-zzM3euaLQt23B64iWn8XO13I4eqeEiCEuB8Zwj0ohObwpMQ/exec';
const APP_SCRIPT_URL = argValue('--script-url') || process.env.DEADHEAD_SCRIPT_URL || extractConst('SCRIPT_URL', DEFAULT_APP_SCRIPT_URL);
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
const SCORE_SOURCES = process.argv.includes('--score-sources');
const ONLY_MODE = argValue('--mode');
const MERGE_EXPORT = argValue('--merge-export');

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : '';
}

function extractConst(name, fallback) {
  let html = '';
  try {
    html = fs.readFileSync(INDEX_HTML, 'utf8');
  } catch (_) {
    return fallback;
  }
  const re = new RegExp("const\\s+" + name + "\\s*=\\s*'([^']+)'");
  const match = html.match(re);
  if (!match) return fallback;
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
    if (/^(set|tuning|banter|crowd|intro|outro)\s*\d*$/i.test(song)) return;
    if (/\d{7,}/.test(song) && !/[a-z]{3,}/i.test(song.replace(/\bfiles?\b/ig, ''))) return;
    if (/\(\s*\d+\s+files?\s*\)/i.test(song)) return;
    if (/\b(?:flac|shn|mp3|ogg|wav|checksum|ffp|md5)\b/i.test(song) && /\d{5,}/.test(song)) return;
    if (/\b(?:jg|gd|bw|phil|plq|paf|tltt)\w*\d{4}\s+\d{2}\s+\d{2}d\d+t\d+/i.test(song)) return;
    if (/\b(?:xx|fix|nonfixed|vbr)\b/i.test(song) && /\d{5,}/.test(song)) return;
    out.push(song);
  });
  return out.slice(0, 80);
}

function cleanGenericTrackLabel(value) {
  return String(value || '')
    .replace(/\.(mp3|flac|shn|ogg|m4a|wav)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function genericTrackSongs(files) {
  const out = [];
  const seen = new Set();
  (Array.isArray(files) ? files : []).forEach(file => {
    const name = String(file.name || '');
    if (!/\.(mp3|flac|shn|ogg|m4a|wav)$/i.test(name)) return;
    if (/64kb|vbr|_thumb|spectrogram|checksums?/i.test(name)) return;
    const label = cleanGenericTrackLabel(file.title || file.name);
    if (!label || label.length < 3) return;
    if (/^(tuning|intro|banter|crowd|encore|encore break)$/i.test(label)) return;
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(label);
  });
  return out.slice(0, 80);
}

function parseDurationSeconds(value) {
  const s = String(value || '').trim();
  if (!s) return 0;
  const parts = s.split(':').map(n => Number(n));
  if (parts.some(n => !Number.isFinite(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(s) || 0;
}

function isGenericSongLabel(value) {
  return /^(?:disc|track)\s*\d+$/i.test(String(value || '').trim());
}

function namedSongCount(songs) {
  return (songs || []).filter(song => !isGenericSongLabel(song)).length;
}

function genericSongCount(songs) {
  return (songs || []).filter(isGenericSongLabel).length;
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

function archiveGroupsFromCatalog(catalog) {
  const byId = {};
  (catalog.shows || []).forEach(show => {
    const primary = normalizeArchiveId(show.archiveId);
    if (!isBuildableArchiveId(primary)) return;
    if (!byId[primary]) byId[primary] = {
      primaryId: primary,
      rows: [],
      sourceIds: []
    };
    byId[primary].rows.push({
      date: show.date || '',
      venue: show.venue || '',
      city: show.city || '',
      row: show.row || '',
      archiveId: primary
    });
    [primary].concat(show.altArchiveIds || []).forEach(id => {
      id = normalizeArchiveId(id);
      if (isBuildableArchiveId(id) && !byId[primary].sourceIds.includes(id)) byId[primary].sourceIds.push(id);
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
  if (fileSongs.length) return fileSongs;
  return genericTrackSongs(candidates);
}

function sourceStatsFromMetadata(archiveId, meta, songs) {
  const files = (meta && meta.files) || [];
  const audioFiles = files.filter(file => {
    const name = String(file.name || '');
    return /\.(mp3|flac|shn|ogg|m4a|wav)$/i.test(name) && !/64kb|vbr|_thumb|spectrogram|checksums?/i.test(name);
  });
  const durationSeconds = audioFiles.reduce((sum, file) => sum + parseDurationSeconds(file.length || file.runtime || file.duration), 0);
  const named = namedSongCount(songs);
  const generic = genericSongCount(songs);
  return {
    id: archiveId,
    title: meta && meta.metadata && meta.metadata.title || '',
    trackCount: audioFiles.length || songs.length,
    setlistCount: songs.length,
    namedCount: named,
    genericCount: generic,
    durationSeconds: durationSeconds,
    score: named * 1000 + songs.length * 35 + Math.min(durationSeconds, 24000) / 6 - generic * 25
  };
}

async function fetchArchiveSource(archiveId) {
  try {
    const meta = await fetchJson(`https://archive.org/metadata/${encodeURIComponent(archiveId)}`);
    const songs = songsFromArchiveMetadata(meta);
    return {
      id: archiveId,
      songs: songs,
      stats: sourceStatsFromMetadata(archiveId, meta, songs)
    };
  } catch (e) {
    console.warn(`  ${archiveId}: ${e.message}`);
    return { id: archiveId, songs: [], stats: { id: archiveId, error: e.message, trackCount: 0, setlistCount: 0, namedCount: 0, genericCount: 0, durationSeconds: 0, score: 0 } };
  }
}

function sourceRecordFromStats(stats, best) {
  stats = stats || {};
  const id = normalizeArchiveId(stats.id);
  if (!id) return null;
  return {
    id,
    title: stats.title || '',
    trackCount: Number(stats.trackCount || 0) || 0,
    setlistCount: Number(stats.setlistCount || 0) || 0,
    namedCount: Number(stats.namedCount || 0) || 0,
    genericCount: Number(stats.genericCount || 0) || 0,
    durationSeconds: Number(stats.durationSeconds || 0) || 0,
    score: Math.round((Number(stats.score || 0) || 0) * 100) / 100,
    manual: true,
    sheetAlt: true,
    best: !!best
  };
}

function sourceRecordFromId(id, best) {
  id = normalizeArchiveId(id);
  return id ? { id, manual: true, sheetAlt: true, best: !!best } : null;
}

function compareSources(a, b) {
  const an = namedSongCount(a && a.songs);
  const bn = namedSongCount(b && b.songs);
  if (bn !== an) return bn - an;
  const al = (a && a.songs && a.songs.length) || 0;
  const bl = (b && b.songs && b.songs.length) || 0;
  if (bl !== al) return bl - al;
  const ad = (a && a.stats && a.stats.durationSeconds) || 0;
  const bd = (b && b.stats && b.stats.durationSeconds) || 0;
  if (bd !== ad) return bd - ad;
  return String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
}

function reportInterestingSetlists(ids, archiveRows, setlists) {
  return ids.map(id => {
    const songs = setlists[id] || [];
    const generic = genericSongCount(songs);
    const named = namedSongCount(songs);
    if (!songs.length || !generic || named) return null;
    return {
      archiveId: id,
      reason: 'generic-track-labels',
      songs,
      shows: archiveRows[id] || []
    };
  }).filter(Boolean);
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
  const archiveGroups = archiveGroupsFromCatalog(catalog);
  const ids = Object.keys(archiveGroups).sort();
  const archiveRows = {};
  ids.forEach(id => { archiveRows[id] = archiveGroups[id].rows || []; });
  const outFile = MODE_FILES[mode.key] || `${mode.key}.json`;
  const outPath = path.join(OUT_DIR, outFile);
  const existing = readJson(outPath, {});
  const setlists = {};
  const sources = {};
  const bestSourceByArchiveId = {};
  Object.keys(existing.setlists || {}).sort().forEach(id => {
    const archiveId = normalizeArchiveId(id);
    const songs = cleanSongs(existing.setlists[id]);
    if (archiveId && songs.length) setlists[archiveId] = songs;
  });
  Object.keys(existing.sources || {}).sort().forEach(id => {
    const archiveId = normalizeArchiveId(id);
    const recs = (existing.sources[id] || []).map(r => {
      const sid = normalizeArchiveId(r && r.id);
      return sid ? Object.assign({}, r, { id: sid }) : null;
    }).filter(Boolean);
    if (archiveId && recs.length) sources[archiveId] = recs;
  });
  Object.keys(existing.bestSourceByArchiveId || {}).forEach(id => {
    const archiveId = normalizeArchiveId(id);
    const best = normalizeArchiveId(existing.bestSourceByArchiveId[id]);
    if (archiveId && best) bestSourceByArchiveId[archiveId] = best;
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

  ids.forEach(id => {
    const sourceIds = (archiveGroups[id].sourceIds || [id]).filter(Boolean);
    if (!sources[id] || !sources[id].length) sources[id] = sourceIds.map((sourceId, idx) => sourceRecordFromId(sourceId, idx === 0)).filter(Boolean);
    if (!bestSourceByArchiveId[id]) bestSourceByArchiveId[id] = id;
  });

  if (!SKIP_EXISTING && SCORE_SOURCES) {
    const groupsToScore = ids.filter(id => (archiveGroups[id].sourceIds || []).length > 1);
    let scored = 0;
    await mapLimit(groupsToScore, 3, async (primaryId, idx) => {
      const sourceIds = archiveGroups[primaryId].sourceIds || [primaryId];
      const results = await mapLimit(sourceIds, 3, fetchArchiveSource);
      const usable = results.filter(r => r && r.songs && r.songs.length).sort(compareSources);
      if (usable.length) {
        const best = usable[0];
        setlists[primaryId] = best.songs;
        bestSourceByArchiveId[primaryId] = best.id;
        sources[primaryId] = results.map(r => sourceRecordFromStats(r.stats, r.id === best.id)).filter(Boolean);
        scored++;
      }
      if ((idx + 1) % 5 === 0 || idx === groupsToScore.length - 1) {
        console.log(`  scored sources ${idx + 1}/${groupsToScore.length}, selected ${scored}`);
      }
    });
  }

  const stillNeedFetch = ids.filter(id => !setlists[id] || !setlists[id].length);
  if (!SKIP_EXISTING && stillNeedFetch.length) {
    let foundCount = 0;
    await mapLimit(stillNeedFetch, 4, async (archiveId, idx) => {
      const result = await fetchArchiveSource(archiveId);
      const songs = result.songs || [];
      if (songs.length) {
        foundCount++;
        setlists[archiveId] = songs;
        sources[archiveId] = [sourceRecordFromStats(result.stats, true)].filter(Boolean);
        bestSourceByArchiveId[archiveId] = archiveId;
      }
      if ((idx + 1) % 5 === 0 || idx === stillNeedFetch.length - 1) {
        console.log(`  checked ${idx + 1}/${stillNeedFetch.length}, found ${foundCount} setlists`);
      }
    });
  }

  const sorted = {};
  ids.forEach(id => {
    if (setlists[id] && setlists[id].length) sorted[id] = setlists[id];
  });
  const sortedSources = {};
  ids.forEach(id => {
    const recs = sources[id] || [];
    if (recs.length > 1 || (bestSourceByArchiveId[id] && bestSourceByArchiveId[id] !== id)) sortedSources[id] = recs;
  });
  const sortedBest = {};
  ids.forEach(id => {
    if (bestSourceByArchiveId[id] && bestSourceByArchiveId[id] !== id) sortedBest[id] = bestSourceByArchiveId[id];
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
  const reviewItems = reportInterestingSetlists(ids, archiveRows, sorted);
  const reviewPath = path.join(OUT_DIR, `review-${outFile}`);
  if (reviewItems.length) {
    fs.writeFileSync(reviewPath, JSON.stringify({
      mode: mode.label,
      modeKey: mode.key,
      updated: new Date().toISOString(),
      review: reviewItems
    }, null, 2) + '\n');
    console.log(`${mode.label}: review report -> data/setlists/${path.basename(reviewPath)}`);
  } else if (fs.existsSync(reviewPath)) {
    fs.unlinkSync(reviewPath);
  }
  const doc = {
    schemaVersion: 2,
    mode: mode.label,
    modeKey: mode.key,
    updated: new Date().toISOString(),
    setlists: sorted,
    sources: sortedSources,
    bestSourceByArchiveId: sortedBest
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
