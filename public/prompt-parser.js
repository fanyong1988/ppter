(function initPromptParser(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PromptParser = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createPromptParser() {
  'use strict';

  function cleanInput(value) {
    let text = String(value || '').replace(/\r\n?/g, '\n').trim();
    if (/^```(?:text|markdown|md)?\s*\n[\s\S]*\n```$/i.test(text)) {
      text = text.replace(/^```(?:text|markdown|md)?\s*\n/i, '').replace(/\n```$/, '').trim();
    }
    return text;
  }

  function splitByPageMarker(text) {
    return splitByBoundary(text, line => /^\s*<!--\s*PAGE\s*-->\s*$/i.test(line));
  }

  function splitByDivider(text) {
    return splitByBoundary(text, line => /^\s*-{3,}\s*$/.test(line));
  }

  function splitByBoundary(text, isBoundary) {
    const pages = [];
    let current = [];
    let inFence = false;
    let found = false;
    for (const line of text.split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      if (!inFence && isBoundary(line)) {
        pages.push(current.join('\n'));
        current = [];
        found = true;
      } else {
        current.push(line);
      }
    }
    pages.push(current.join('\n'));
    return found ? pages : null;
  }

  function splitByPageHeading(text) {
    const pattern = /^(?:#{1,6}\s*)?第\s*[一二三四五六七八九十百零〇两\d]+\s*页(?:\s*[：:｜|].*)?\s*$/gm;
    const matches = Array.from(text.matchAll(pattern));
    if (matches.length < 2) return null;
    const pages = [];
    for (let index = 0; index < matches.length; index++) {
      const start = matches[index].index;
      const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
      pages.push(text.slice(start, end));
    }
    if (matches[0].index > 0) {
      const preface = text.slice(0, matches[0].index).trim();
      if (preface) pages.unshift(preface);
    }
    return pages;
  }

  function splitByFieldHeading(text) {
    const matches = Array.from(text.matchAll(/^\s*页面类型\s*[：:]/gm));
    if (matches.length < 2) return null;
    return matches.map((match, index) => text.slice(match.index, matches[index + 1]?.index ?? text.length));
  }

  function extractTitle(prompt, index) {
    const titleMatch = prompt.match(/(?:^|\n)\s*(?:页面类型|标题|主标题)\s*[：:]\s*([^\n]+)/i);
    if (titleMatch) return titleMatch[1].trim().slice(0, 80);
    const headingMatch = prompt.match(/^\s*(?:#{1,6}\s*)?([^\n]{2,80})/);
    return headingMatch ? headingMatch[1].trim() : `第 ${index + 1} 页`;
  }

  function parse(value) {
    const text = cleanInput(value);
    if (!text) return [];
    const rawPages = splitByPageMarker(text)
      || splitByDivider(text)
      || splitByPageHeading(text)
      || splitByFieldHeading(text)
      || [text];
    return rawPages
      .map(page => page.trim())
      .filter(Boolean)
      .map((prompt, index) => ({
        title: extractTitle(prompt, index),
        prompt,
      }));
  }

  return { cleanInput, extractTitle, parse };
}));
