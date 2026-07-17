// src/utils/epubUtils.js
// EPUB reading for the Import tab (Stage 9.6). An EPUB is a zip of XHTML
// chapters; this module opens one in memory (nothing is stored), lists
// its chapters in spine order, and extracts plain text from selected
// chapters. DRM-protected files fail at open and surface as a caught
// error. Requires the jszip dependency.

import JSZip from 'jszip';

// Strip tags to text while preserving paragraph breaks. DOMParser is used
// only for entity decoding of already-tag-stripped content.
export function htmlToText(html) {
  let src = String(html || '');
  // Use only the body when present — head titles must not leak into text.
  const body = src.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (body) src = body[1];
  const withBreaks = src
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|dd|dt)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html');
  const text = (doc.documentElement && doc.documentElement.textContent) || '';
  return text
    .replace(/[ \t\u00A0]+/g, ' ')
    .split('\n').map(l => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i + 1);
}

function resolveHref(base, href) {
  // Resolve ../ and ./ relative to the OPF directory.
  const parts = (base + href).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

function attr(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*["\\\']([^"\\\']*)["\\\']', 'i'));
  return m ? m[1] : '';
}

// Open an EPUB from an ArrayBuffer. Returns { chapters, extractText }:
//   chapters:    [{ href, title }] in reading (spine) order
//   extractText: async (hrefs) => plain text of those chapters, joined
export async function openEpub(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);

  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('Not a valid EPUB (missing container.xml)');
  const container = await containerFile.async('string');
  const rootMatch = container.match(/<rootfile[^>]*full-path\s*=\s*["']([^"']+)["']/i);
  if (!rootMatch) throw new Error('Not a valid EPUB (no rootfile)');
  const opfPath = rootMatch[1];
  const opfDir  = dirOf(opfPath);

  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error('Not a valid EPUB (missing package file)');
  const opf = await opfFile.async('string');

  // Manifest: id -> { href, mediaType }
  const manifest = {};
  for (const tag of opf.match(/<item\b[^>]*>/gi) || []) {
    const id = attr(tag, 'id');
    if (id) manifest[id] = { href: attr(tag, 'href'), mediaType: attr(tag, 'media-type') };
  }

  // Spine: reading order of xhtml documents
  const hrefs = [];
  for (const tag of opf.match(/<itemref\b[^>]*>/gi) || []) {
    const item = manifest[attr(tag, 'idref')];
    if (!item || !item.href) continue;
    if (item.mediaType && !/xhtml|html/i.test(item.mediaType)) continue;
    hrefs.push(resolveHref(opfDir, item.href));
  }
  if (hrefs.length === 0) throw new Error('No readable chapters found (the file may be DRM-protected)');

  // Titles: <title> or first heading of each chapter, else Chapter N.
  const chapters = await Promise.all(hrefs.map(async (href, i) => {
    let title = '';
    try {
      const f = zip.file(href);
      const html = f ? await f.async('string') : '';
      const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ||
                html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
      if (t) title = htmlToText(t[1]).replace(/\n+/g, ' ').trim();
    } catch {}
    return { href, title: title || `Chapter ${i + 1}` };
  }));

  const extractText = async (selectedHrefs) => {
    const parts = [];
    for (const href of selectedHrefs) {
      const f = zip.file(href);
      if (!f) continue;
      try {
        const html = await f.async('string');
        const text = htmlToText(html);
        if (text) parts.push(text);
      } catch {}
    }
    return parts.join('\n\n');
  };

  return { chapters, extractText };
}