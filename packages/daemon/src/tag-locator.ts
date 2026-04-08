import type { TagFingerprint, TagMatch, TagRecord } from "@bb-browser/shared";
import { CdpConnection } from "./cdp-connection.js";

function escapeForTemplate(value: string): string {
  return JSON.stringify(value);
}

export async function extractTagFingerprint(
  cdp: CdpConnection,
  targetId: string,
  backendNodeId: number,
): Promise<TagFingerprint> {
  const resolved = await cdp.sessionCommand<{ object: { objectId: string } }>(
    targetId,
    "DOM.resolveNode",
    { backendNodeId },
  );

  const call = await cdp.sessionCommand<{ result: { value: TagFingerprint } }>(
    targetId,
    "Runtime.callFunctionOn",
    {
      objectId: resolved.object.objectId,
      returnByValue: true,
      functionDeclaration: `function() {
        const node = this;
        if (!(node instanceof Element)) {
          throw new Error('Tag source is not an element');
        }
        const attrMap = (prefix) => {
          const out = {};
          for (const name of node.getAttributeNames()) {
            if (name.startsWith(prefix)) {
              out[name] = node.getAttribute(name) || '';
            }
          }
          return out;
        };
        const getXPath = (el) => {
          if (!(el instanceof Element)) return '';
          const segments = [];
          let current = el;
          while (current && current.nodeType === Node.ELEMENT_NODE) {
            let index = 1;
            let sibling = current.previousElementSibling;
            while (sibling) {
              if (sibling.tagName === current.tagName) index += 1;
              sibling = sibling.previousElementSibling;
            }
            segments.unshift(current.tagName.toLowerCase() + '[' + index + ']');
            current = current.parentElement;
          }
          return '/' + segments.join('/');
        };
        const normalizeText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const role = node.getAttribute('role')
          || ({ a: 'link', button: 'button', select: 'combobox', textarea: 'textbox' }[node.tagName.toLowerCase()])
          || ((node.tagName.toLowerCase() === 'input')
            ? ({ checkbox: 'checkbox', radio: 'radio', search: 'searchbox' }[(node.getAttribute('type') || 'text').toLowerCase()] || 'textbox')
            : undefined);

        const classTokens = Array.from(node.classList)
          .filter((token) => token && !/^css-|^jsx-|^sc-/.test(token))
          .slice(0, 5);

        return {
          tagName: node.tagName.toLowerCase(),
          role: role || undefined,
          name: normalizeText(node.getAttribute('aria-label') || node.getAttribute('title') || ''),
          text: normalizeText(node.innerText || node.textContent || '').slice(0, 200) || undefined,
          placeholder: node.getAttribute('placeholder') || undefined,
          id: node.id || undefined,
          inputName: node.getAttribute('name') || undefined,
          classTokens,
          dataAttributes: attrMap('data-'),
          ariaAttributes: attrMap('aria-'),
          xpath: getXPath(node),
          parentXPath: node.parentElement ? getXPath(node.parentElement) : undefined,
          parentTagName: node.parentElement ? node.parentElement.tagName.toLowerCase() : undefined,
        };
      }`,
    },
  );

  return call.result.value;
}

export async function resolveTagMatches(
  cdp: CdpConnection,
  targetId: string,
  record: TagRecord,
): Promise<TagMatch[]> {
  const expression = `(() => {
    const record = ${escapeForTemplate(JSON.stringify(record))};
    const fingerprint = JSON.parse(record).fingerprint;
    const mode = JSON.parse(record).mode;

    const normalizeText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const getXPath = (el) => {
      if (!(el instanceof Element)) return '';
      const segments = [];
      let current = el;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        let index = 1;
        let sibling = current.previousElementSibling;
        while (sibling) {
          if (sibling.tagName === current.tagName) index += 1;
          sibling = sibling.previousElementSibling;
        }
        segments.unshift(current.tagName.toLowerCase() + '[' + index + ']');
        current = current.parentElement;
      }
      return '/' + segments.join('/');
    };
    const getRole = (el) => {
      return el.getAttribute('role')
        || ({ a: 'link', button: 'button', select: 'combobox', textarea: 'textbox' }[el.tagName.toLowerCase()])
        || ((el.tagName.toLowerCase() === 'input')
          ? ({ checkbox: 'checkbox', radio: 'radio', search: 'searchbox' }[(el.getAttribute('type') || 'text').toLowerCase()] || 'textbox')
          : undefined);
    };
    const getDataAttrs = (el) => {
      const out = {};
      for (const name of el.getAttributeNames()) {
        if (name.startsWith('data-')) out[name] = el.getAttribute(name) || '';
      }
      return out;
    };
    const getAriaAttrs = (el) => {
      const out = {};
      for (const name of el.getAttributeNames()) {
        if (name.startsWith('aria-')) out[name] = el.getAttribute(name) || '';
      }
      return out;
    };
    const hasAllAttrs = (candidate, required) => {
      const entries = Object.entries(required || {});
      return entries.every(([key, value]) => candidate[key] === value);
    };
    const classTokens = (el) => Array.from(el.classList)
      .filter((token) => token && !/^css-|^jsx-|^sc-/.test(token));
    const commonClassCount = (el) => {
      const wanted = fingerprint.classTokens || [];
      if (wanted.length === 0) return 0;
      const actual = new Set(classTokens(el));
      return wanted.filter((token) => actual.has(token)).length;
    };
    const allElements = Array.from(document.querySelectorAll('*'));
    const exactXPath = fingerprint.xpath
      ? allElements.find((el) => getXPath(el) === fingerprint.xpath)
      : null;

    const parentForList = mode === 'list' && fingerprint.parentXPath
      ? allElements.find((el) => getXPath(el) === fingerprint.parentXPath)
      : null;
    const listPool = parentForList instanceof Element
      ? Array.from(parentForList.children)
      : allElements;

    const matches = [];
    const pool = mode === 'list' ? listPool : allElements;

    for (const el of pool) {
      if (!(el instanceof Element)) continue;
      if (fingerprint.tagName && el.tagName.toLowerCase() !== fingerprint.tagName) continue;
      if (mode === 'list' && fingerprint.parentTagName && el.parentElement?.tagName.toLowerCase() !== fingerprint.parentTagName) continue;
      if (fingerprint.id && el.id && el.id === fingerprint.id) {
        matches.push({
          el,
          score: 1000,
          tagName: el.tagName.toLowerCase(),
          role: getRole(el) || undefined,
          name: normalizeText(el.getAttribute('aria-label') || el.getAttribute('title') || '') || undefined,
          text: normalizeText(el.innerText || el.textContent || '').slice(0, 200) || undefined,
        });
        continue;
      }
      const dataAttrs = getDataAttrs(el);
      const ariaAttrs = getAriaAttrs(el);
      if (!hasAllAttrs(dataAttrs, fingerprint.dataAttributes) || !hasAllAttrs(ariaAttrs, fingerprint.ariaAttributes)) continue;
      if (fingerprint.inputName && el.getAttribute('name') !== fingerprint.inputName) continue;
      if (fingerprint.placeholder && el.getAttribute('placeholder') !== fingerprint.placeholder) continue;
      if (fingerprint.role && getRole(el) !== fingerprint.role) continue;
      if (mode === 'single' && fingerprint.name) {
        const candidateName = normalizeText(el.getAttribute('aria-label') || el.getAttribute('title') || '');
        if (candidateName !== fingerprint.name) continue;
      }

      let score = 0;
      if (exactXPath === el) score += 200;
      if (fingerprint.text) {
        const candidateText = normalizeText(el.innerText || el.textContent || '').slice(0, 200);
        if (candidateText === fingerprint.text) score += 40;
        else if (mode === 'single') continue;
      }
      score += commonClassCount(el) * 5;
      if (fingerprint.parentXPath && getXPath(el.parentElement) === fingerprint.parentXPath) score += 10;
      score += Object.keys(fingerprint.dataAttributes || {}).length * 20;
      score += Object.keys(fingerprint.ariaAttributes || {}).length * 10;
      matches.push({
        el,
        score,
        tagName: el.tagName.toLowerCase(),
        role: getRole(el) || undefined,
        name: normalizeText(el.getAttribute('aria-label') || el.getAttribute('title') || '') || undefined,
        text: normalizeText(el.innerText || el.textContent || '').slice(0, 200) || undefined,
      });
    }

    const normalized = matches
      .filter((match) => match.score > 0 || mode === 'list')
      .map((match, index) => ({
        index,
        xpath: getXPath(match.el),
        tagName: match.tagName,
        role: match.role,
        name: match.name,
        text: match.text,
        score: match.score,
      }));

    if (mode === 'single') {
      normalized.sort((a, b) => b.score - a.score);
      if (normalized.length === 0) return [];
      const top = normalized[0];
      const second = normalized[1];
      if (!top || top.score < 20) return [];
      if (second && second.score === top.score) {
        return normalized.slice(0, 2);
      }
      return [{
        index: 0,
        xpath: top.xpath,
        tagName: top.tagName,
        role: top.role,
        name: top.name,
        text: top.text,
      }];
    }

    return normalized.map((match, index) => ({
      index,
      xpath: match.xpath,
      tagName: match.tagName,
      role: match.role,
      name: match.name,
      text: match.text,
    }));
  })()`;

  return cdp.evaluate<TagMatch[]>(targetId, expression, true);
}
