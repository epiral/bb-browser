/**
 * trace-inject.js — DOM event listener injection script for trace recording.
 *
 * Injected via CDP Runtime.evaluate into the page context on trace start.
 * Sends events back to the daemon via CDP Runtime.addBinding.
 *
 * Ported from packages/extension/src/content/trace.ts (commit f02b081).
 * Key change: chrome.runtime.sendMessage → window.__bbBrowserTraceBinding()
 */

export const TRACE_PREFIX = "__BB_BROWSER_TRACE_8fd3__:";

export const TRACE_INJECTION_SCRIPT = `
(function bbInject() {
  // Re-entrant: if the top-level was already injected, we still want to walk
  // frames again because a Page.frameNavigated event may have spawned new ones
  // (frameset 'mainFrame' navigates between sub-pages on portal sites).
  var alreadyInjected = !!window.__bbBrowserTraceInjected;
  window.__bbBrowserTraceInjected = true;
  if (alreadyInjected) {
    // Jump straight to the frame walker at the bottom.
    walkFrames();
    return;
  }

  // ---- Helpers ----

  function getXPath(element) {
    if (element.id) return '//*[@id="' + element.id + '"]';
    if (element === document.body) return '/html/body';
    var idx = 1;
    var siblings = element.parentNode && element.parentNode.children;
    if (siblings) {
      for (var i = 0; i < siblings.length; i++) {
        var sib = siblings[i];
        if (sib === element) {
          var parentPath = element.parentElement ? getXPath(element.parentElement) : '';
          return parentPath + '/' + element.tagName.toLowerCase() + '[' + idx + ']';
        }
        if (sib.nodeType === 1 && sib.tagName === element.tagName) idx++;
      }
    }
    return element.tagName.toLowerCase();
  }

  function getHighlightIndex(element) {
    var cur = element;
    while (cur) {
      var attr = cur.getAttribute('data-highlight-index');
      if (attr !== null) { var n = parseInt(attr, 10); if (!isNaN(n)) return n; }
      cur = cur.parentElement;
    }
  }

  function getCssSelector(element) {
    var parts = [];
    var cur = element;
    while (cur && cur !== document.body) {
      var sel = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift('#' + cur.id); break; }
      if (cur.className) {
        var cls = cur.className.split(/\\s+/).filter(function(c) { return c && /^[a-zA-Z_]/.test(c); });
        if (cls.length > 0) sel += '.' + cls.slice(0, 2).join('.');
      }
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function extractInfo(element) {
    var tag = element.tagName.toLowerCase();
    var role = element.getAttribute('role') || '';
    if (!role) {
      if (tag === 'button') role = 'button';
      else if (tag === 'a') role = 'link';
      else if (tag === 'input') {
        var t = (element.type || 'text').toLowerCase();
        if (t === 'checkbox') role = 'checkbox';
        else if (t === 'radio') role = 'radio';
        else if (t === 'submit' || t === 'button') role = 'button';
        else role = 'textbox';
      } else if (tag === 'textarea') role = 'textbox';
      else if (tag === 'select') role = 'combobox';
      else if (tag === 'img') role = 'img';
      else if (tag === 'label') role = 'label';
      else role = tag;
    }
    var name = element.getAttribute('aria-label') || '';
    if (!name) {
      var lb = element.getAttribute('aria-labelledby');
      if (lb) { var le = document.getElementById(lb); if (le) name = (le.textContent || '').trim(); }
    }
    if (!name && element.id) {
      var l = document.querySelector('label[for="' + element.id + '"]');
      if (l) name = (l.textContent || '').trim();
    }
    if (!name) name = element.getAttribute('title') || element.getAttribute('alt') || (element.placeholder) || (element.textContent || '').trim().slice(0, 50) || '';
    return { role: role || tag, name: name || '', tag: tag };
  }

  function emit(eventObj) {
    console.log('__BB_BROWSER_TRACE_8fd3__:' + JSON.stringify(eventObj));
  }

  // ---- Interactive element detection ----
  var _interactiveTags = new Set(['a','button','input','textarea','select','option','label','summary','details']);
  var _interactiveRoles = new Set(['button','link','textbox','checkbox','radio','combobox','slider','tab','menuitem','option','switch','searchbox','spinbutton']);
  function isInteractive(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (_interactiveTags.has(el.tagName.toLowerCase())) return true;
    var role = el.getAttribute('role');
    if (role && _interactiveRoles.has(role)) return true;
    if (el.getAttribute('tabindex') !== null) return true;
    if (el.tagName === 'IMG' && el.getAttribute('usemap')) return true;
    return false;
  }
  function findInteractiveTarget(el) {
    var cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (isInteractive(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  // ---- Click handler ----
  var _lastClickKey = null, _lastClickTime = 0;
  document.addEventListener('click', function(e) {
    if (!window.__bbBrowserTraceRecording) return;
    var target = findInteractiveTarget(e.target);
    if (!target) return;
    var info = extractInfo(target);
    var isCheckbox = target.tagName === 'INPUT' && (target.type || '').toLowerCase() === 'checkbox';
    // Deduplicate: same element clicked within 300ms
    var key = target.tagName + ':' + getXPath(target);
    var now = Date.now();
    if (key === _lastClickKey && now - _lastClickTime < 300) return;
    _lastClickKey = key;
    _lastClickTime = now;
    emit({
      type: isCheckbox ? 'check' : 'click',
      timestamp: now,
      url: location.href,
      ref: getHighlightIndex(target),
      xpath: getXPath(target),
      cssSelector: getCssSelector(target),
      elementRole: info.role,
      elementName: info.name,
      elementTag: info.tag,
      checked: isCheckbox ? target.checked : undefined
    });
  }, true);

  // ---- Input handler (debounced 500ms) ----
  var _inputTimer = null, _lastEl = null, _lastInfo = null;
  document.addEventListener('input', function(e) {
    if (!window.__bbBrowserTraceRecording) return;
    var target = e.target;
    if (!target || !('value' in target)) return;
    if (_inputTimer) clearTimeout(_inputTimer);
    _lastEl = target;
    _lastInfo = extractInfo(target);
    _inputTimer = setTimeout(function() {
      if (!_lastEl) return;
      var isPw = (_lastEl.type || '').toLowerCase() === 'password';
      emit({
        type: 'fill',
        timestamp: Date.now(),
        url: location.href,
        ref: getHighlightIndex(_lastEl),
        xpath: getXPath(_lastEl),
        cssSelector: getCssSelector(_lastEl),
        value: isPw ? '********' : (_lastEl.value || ''),
        elementRole: _lastInfo.role,
        elementName: _lastInfo.name,
        elementTag: _lastInfo.tag
      });
      _inputTimer = null; _lastEl = null; _lastInfo = null;
    }, 500);
  }, true);

  // ---- Change handler (select) ----
  document.addEventListener('change', function(e) {
    if (!window.__bbBrowserTraceRecording) return;
    var target = e.target;
    if (!target || target.tagName !== 'SELECT') return;
    var info = extractInfo(target);
    emit({
      type: 'select',
      timestamp: Date.now(),
      url: location.href,
      ref: getHighlightIndex(target),
      xpath: getXPath(target),
      cssSelector: getCssSelector(target),
      value: target.options[target.selectedIndex] ? target.options[target.selectedIndex].text : target.value,
      elementRole: info.role,
      elementName: info.name,
      elementTag: info.tag
    });
  }, true);

  // ---- Keydown handler (special keys only, deduplicated) ----
  var _capturedKeys = new Set(['Enter','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Backspace','Delete']);
  var _lastKeyLog = null, _lastKeyTime = 0;
  document.addEventListener('keydown', function(e) {
    if (!window.__bbBrowserTraceRecording) return;
    var key = e.key, keyLog = '';
    if (_capturedKeys.has(key)) keyLog = key;
    else if ((e.ctrlKey || e.metaKey) && key.length === 1 && /[a-zA-Z0-9]/.test(key)) keyLog = (e.metaKey ? 'Meta' : 'Control') + '+' + key.toLowerCase();
    if (!keyLog) return;
    // Deduplicate: same key within 50ms (keyboard repeat)
    var now = Date.now();
    if (keyLog === _lastKeyLog && now - _lastKeyTime < 50) return;
    _lastKeyLog = keyLog;
    _lastKeyTime = now;
    var target = e.target;
    var info = target ? extractInfo(target) : { role: '', name: '', tag: 'document' };
    emit({
      type: 'press',
      timestamp: Date.now(),
      url: location.href,
      ref: target ? getHighlightIndex(target) : undefined,
      xpath: target ? getXPath(target) : undefined,
      cssSelector: target ? getCssSelector(target) : undefined,
      key: keyLog,
      elementRole: info.role,
      elementName: info.name,
      elementTag: info.tag
    });
  }, true);

  // ---- Scroll handler (debounced 300ms, min 200px) ----
  var _scrollTimer = null, _scrollStartY = 0;
  window.addEventListener('scroll', function() {
    if (!window.__bbBrowserTraceRecording) return;
    if (!_scrollTimer) _scrollStartY = window.scrollY;
    else clearTimeout(_scrollTimer);
    _scrollTimer = setTimeout(function() {
      var deltaY = window.scrollY - _scrollStartY;
      if (Math.abs(deltaY) < 200) { _scrollTimer = null; return; }
      emit({
        type: 'scroll',
        timestamp: Date.now(),
        url: location.href,
        direction: deltaY > 0 ? 'down' : 'up',
        pixels: Math.abs(deltaY)
      });
      _scrollTimer = null;
    }, 300);
  }, { passive: true });

  // ---- Navigation handler (SPA history: popstate + hashchange) ----
  // Captures back/forward and hash changes inside an SPA. Full-document
  // navigations are reported by the daemon via Page.frameNavigated instead.
  var _lastNavUrl = location.href;
  function emitNav() {
    if (!window.__bbBrowserTraceRecording) return;
    var url = location.href;
    if (url === _lastNavUrl) return;
    _lastNavUrl = url;
    emit({ type: 'navigation', timestamp: Date.now(), url: url });
  }
  window.addEventListener('popstate', emitNav);
  window.addEventListener('hashchange', emitNav);

  // ---- Inject into accessible frames (same-origin frameset/iframe support) ----
  function injectIntoFrame(el) {
    try {
      var fw = el.contentWindow;
      if (!fw) return;
      // Always (re)sync recording state, even if already injected.
      // The frame may have been injected during a prior start() when
      // recording was false, then never updated.
      fw.__bbBrowserTraceRecording = window.__bbBrowserTraceRecording;
      if (!fw.__bbBrowserTraceInjected) {
        var script = fw.document.createElement('script');
        script.textContent = '(' + bbInject.toString() + ')()';
        (fw.document.head || fw.document.documentElement).appendChild(script);
        script.parentNode && script.parentNode.removeChild(script);
      }
    } catch(e) {} // Cross-origin frames are inaccessible — skip silently
  }
  function walkFrames() {
    Array.from(document.querySelectorAll('frame, iframe')).forEach(function(el) {
      injectIntoFrame(el);
      // Re-inject when this frame loads new content (frameset navigation,
      // iframe src change, etc.). Guard against multiple registrations.
      if (!el.__bbBrowserLoadHooked) {
        el.__bbBrowserLoadHooked = true;
        el.addEventListener('load', function() { injectIntoFrame(el); });
      }
    });
  }
  walkFrames();
})();
`;
