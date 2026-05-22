/**
 * 导出对话框 - 支持导出为不同语言的代码
 */

import { useStore } from '../store/useStore';
import { useState } from 'react';

/**
 * Quote a value as a JS/Python string literal. Uses JSON.stringify so all
 * special chars (newline, tab, unicode, backslash, quotes) are handled.
 */
function q(str) {
  return JSON.stringify(str ?? '');
}

/**
 * Pick the locator for a trace event under the chosen selector mode.
 * Returns `{ value, kind }` where kind is 'css' | 'xpath' | null.
 * Modes:
 *   - auto:  ref → css → xpath (default, matches bb-browser priority)
 *   - css:   cssSelector → xpath (portable, no bb-browser attr dependency)
 *   - xpath: xpath only (most stable across DOM changes)
 */
function pickSelector(event, mode) {
  if (mode === 'xpath') {
    if (event.xpath) return { value: event.xpath, kind: 'xpath' };
    return null;
  }
  if (mode === 'css') {
    if (event.cssSelector) return { value: event.cssSelector, kind: 'css' };
    if (event.xpath) return { value: event.xpath, kind: 'xpath' };
    return null;
  }
  // auto
  if (event.ref !== undefined && event.ref !== null) {
    return { value: `[data-highlight-index="${event.ref}"]`, kind: 'css' };
  }
  if (event.cssSelector) return { value: event.cssSelector, kind: 'css' };
  if (event.xpath) return { value: event.xpath, kind: 'xpath' };
  return null;
}

/** Playwright locator string: xpath selectors get an explicit prefix. */
function playwrightLocator(sel) {
  if (sel.kind === 'xpath') return `xpath=${sel.value}`;
  return sel.value;
}

function ExportDialog() {
  const { showExporter, setShowExporter, traceEvents, activeTab } = useStore();
  const [exportFormat, setExportFormat] = useState('javascript');
  const [selectorMode, setSelectorMode] = useState('auto');
  const [addWaits, setAddWaits] = useState(true);
  const [exportedCode, setExportedCode] = useState('');

  if (!showExporter) return null;

  const generateCode = () => {
    if (traceEvents.length === 0) {
      setExportedCode('// 暂无可导出的事件');
      return;
    }

    switch (exportFormat) {
      case 'javascript':
        setExportedCode(generateJavaScript());
        break;
      case 'playwright':
        setExportedCode(generatePlaywright());
        break;
      case 'python':
        setExportedCode(generatePython());
        break;
      default:
        setExportedCode('// 未知格式');
    }
  };

  /**
   * Drop the first navigation event when it matches activeTab.url so we don't
   * emit `page.goto(X)` twice (the codegen always opens with that URL).
   */
  const normalizedEvents = () => {
    const initialUrl = activeTab?.url || '';
    const events = traceEvents.slice();
    if (
      initialUrl &&
      events.length > 0 &&
      events[0].type === 'navigation' &&
      events[0].url === initialUrl
    ) {
      events.shift();
    }
    return events;
  };

  const generateJavaScript = () => {
    const events = normalizedEvents();
    let code = '// 自动生成的录制脚本\n';
    code += `// URL: ${activeTab?.url || 'N/A'}\n`;
    code += `// 生成时间: ${new Date().toLocaleString()}\n`;
    code += `// 选择器模式: ${selectorMode}\n\n`;
    code += 'async function run() {\n';

    if (activeTab?.url) {
      code += `  await page.goto(${q(activeTab.url)});\n`;
    }

    events.forEach((event, index) => {
      code += `  // 步骤 ${index + 1}: ${event.type}\n`;

      if (event.type === 'navigation') {
        if (event.url) code += `  await page.goto(${q(event.url)});\n`;
        return;
      }

      const sel = pickSelector(event, selectorMode);
      const locator = sel ? playwrightLocator(sel) : null;

      if (event.type === 'click' && locator) {
        if (addWaits) code += `  await page.waitForSelector(${q(locator)});\n`;
        code += `  await page.click(${q(locator)});\n`;
      } else if (event.type === 'fill' && locator && event.value) {
        if (addWaits) code += `  await page.waitForSelector(${q(locator)});\n`;
        code += `  await page.fill(${q(locator)}, ${q(event.value)});\n`;
      } else if (event.type === 'select' && locator && event.value) {
        if (addWaits) code += `  await page.waitForSelector(${q(locator)});\n`;
        code += `  await page.selectOption(${q(locator)}, ${q(event.value)});\n`;
      } else if (event.type === 'check' && locator) {
        if (addWaits) code += `  await page.waitForSelector(${q(locator)});\n`;
        code += `  await page.check(${q(locator)});\n`;
      } else if (event.type === 'press' && event.key) {
        code += `  await page.keyboard.press(${q(event.key)});\n`;
      } else if (event.type === 'scroll') {
        const dir = event.direction || 'down';
        const px = event.pixels || 300;
        code += `  await page.mouse.wheel(0, ${dir === 'up' ? -px : px});\n`;
      }
    });

    code += '}\n';
    return code;
  };

  const generatePlaywright = () => {
    const events = normalizedEvents();
    let code = '// Playwright 测试脚本\n';
    code += `// 选择器模式: ${selectorMode}\n`;
    code += `import { test, expect } from '@playwright/test';\n\n`;
    code += `test('录制测试', async ({ page }) => {\n`;

    if (activeTab?.url) {
      code += `  await page.goto(${q(activeTab.url)});\n`;
    }

    events.forEach((event) => {
      code += `  // ${event.type}\n`;

      if (event.type === 'navigation') {
        if (event.url) code += `  await page.goto(${q(event.url)});\n`;
        return;
      }

      const sel = pickSelector(event, selectorMode);
      const locator = sel ? playwrightLocator(sel) : null;

      if (event.type === 'click' && locator) {
        if (addWaits) code += `  await page.locator(${q(locator)}).waitFor();\n`;
        code += `  await page.locator(${q(locator)}).click();\n`;
      } else if (event.type === 'fill' && locator && event.value) {
        if (addWaits) code += `  await page.locator(${q(locator)}).waitFor();\n`;
        code += `  await page.locator(${q(locator)}).fill(${q(event.value)});\n`;
      } else if (event.type === 'select' && locator && event.value) {
        if (addWaits) code += `  await page.locator(${q(locator)}).waitFor();\n`;
        code += `  await page.locator(${q(locator)}).selectOption(${q(event.value)});\n`;
      } else if (event.type === 'check' && locator) {
        if (addWaits) code += `  await page.locator(${q(locator)}).waitFor();\n`;
        code += `  await page.locator(${q(locator)}).check();\n`;
      } else if (event.type === 'press' && event.key) {
        code += `  await page.keyboard.press(${q(event.key)});\n`;
      } else if (event.type === 'scroll') {
        const dir = event.direction || 'down';
        const px = event.pixels || 300;
        code += `  await page.mouse.wheel(0, ${dir === 'up' ? -px : px});\n`;
      }
    });

    code += '});\n';
    return code;
  };

  const generatePython = () => {
    const events = normalizedEvents();
    let code = '# Selenium Python 脚本\n';
    code += `# 选择器模式: ${selectorMode}\n`;
    code += `from selenium import webdriver\n`;
    code += `from selenium.webdriver.common.by import By\n`;
    code += `from selenium.webdriver.common.keys import Keys\n`;
    code += `from selenium.webdriver.support.ui import WebDriverWait\n`;
    code += `from selenium.webdriver.support import expected_conditions as EC\n\n`;
    code += `driver = webdriver.Chrome()\n`;
    code += `wait = WebDriverWait(driver, 10)\n\n`;

    if (activeTab?.url) {
      code += `driver.get(${q(activeTab.url)})\n\n`;
    }

    events.forEach((event) => {
      if (event.type === 'navigation') {
        if (event.url) code += `driver.get(${q(event.url)})\n`;
        return;
      }

      const sel = pickSelector(event, selectorMode);
      if (!sel && event.type !== 'press' && event.type !== 'scroll') return;
      const by = sel?.kind === 'xpath' ? 'By.XPATH' : 'By.CSS_SELECTOR';

      const waitFor = (loc) =>
        addWaits
          ? `wait.until(EC.presence_of_element_located((${by}, ${q(loc)})))\n`
          : '';

      if (event.type === 'click' && sel) {
        code += waitFor(sel.value);
        code += `driver.find_element(${by}, ${q(sel.value)}).click()\n`;
      } else if (event.type === 'fill' && sel && event.value) {
        code += waitFor(sel.value);
        code += `el = driver.find_element(${by}, ${q(sel.value)})\n`;
        code += `el.clear()\n`;
        code += `el.send_keys(${q(event.value)})\n`;
      } else if (event.type === 'select' && sel && event.value) {
        code += `from selenium.webdriver.support.ui import Select\n`;
        code += waitFor(sel.value);
        code += `Select(driver.find_element(${by}, ${q(sel.value)})).select_by_value(${q(event.value)})\n`;
      } else if (event.type === 'check' && sel) {
        code += waitFor(sel.value);
        code += `el = driver.find_element(${by}, ${q(sel.value)})\n`;
        code += `if not el.is_selected(): el.click()\n`;
      } else if (event.type === 'press' && event.key) {
        code += `from selenium.webdriver.common.action_chains import ActionChains\n`;
        code += `ActionChains(driver).send_keys(Keys.${event.key.toUpperCase()}).perform()\n`;
      } else if (event.type === 'scroll') {
        const dir = event.direction || 'down';
        const px = event.pixels || 300;
        const y = dir === 'up' ? -px : px;
        code += `driver.execute_script(${q(`window.scrollBy(0, ${y})`)})\n`;
      }
    });

    code += `\ndriver.quit()\n`;
    return code;
  };

  const handleCopy = async () => {
    if (!exportedCode) {
      generateCode();
    }
    await navigator.clipboard.writeText(exportedCode);
    alert('已复制到剪贴板');
  };

  const handleDownload = () => {
    if (!exportedCode) {
      generateCode();
    }
    const extensions = {
      javascript: 'js',
      playwright: 'js',
      python: 'py',
    };
    const blob = new Blob([exportedCode], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trace.${extensions[exportFormat] || 'txt'}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleClose = () => {
    setShowExporter(false);
    setExportedCode('');
  };

  return (
    <div className="export-overlay" onClick={handleClose}>
      <div className="export-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="export-header">
          <h2>导出录制</h2>
          <button className="close-btn" onClick={handleClose}>×</button>
        </div>

        <div className="export-content">
          <div className="export-options">
            <label>
              <input
                type="radio"
                value="javascript"
                checked={exportFormat === 'javascript'}
                onChange={(e) => setExportFormat(e.target.value)}
              />
              JavaScript
            </label>
            <label>
              <input
                type="radio"
                value="playwright"
                checked={exportFormat === 'playwright'}
                onChange={(e) => setExportFormat(e.target.value)}
              />
              Playwright
            </label>
            <label>
              <input
                type="radio"
                value="python"
                checked={exportFormat === 'python'}
                onChange={(e) => setExportFormat(e.target.value)}
              />
              Python
            </label>
          </div>

          <div className="export-options" style={{ marginTop: 8 }}>
            <span style={{ marginRight: 8, opacity: 0.7 }}>选择器:</span>
            <label title="ref (bb-browser) → CSS → XPath">
              <input
                type="radio"
                value="auto"
                checked={selectorMode === 'auto'}
                onChange={(e) => setSelectorMode(e.target.value)}
              />
              Auto
            </label>
            <label title="CSS 选择器，便于在标准 Playwright/Selenium 环境运行">
              <input
                type="radio"
                value="css"
                checked={selectorMode === 'css'}
                onChange={(e) => setSelectorMode(e.target.value)}
              />
              CSS
            </label>
            <label title="XPath，跨 DOM 变化更稳定">
              <input
                type="radio"
                value="xpath"
                checked={selectorMode === 'xpath'}
                onChange={(e) => setSelectorMode(e.target.value)}
              />
              XPath
            </label>
            <label
              style={{ marginLeft: 16 }}
              title="在每个动作前插入 waitForSelector / WebDriverWait"
            >
              <input
                type="checkbox"
                checked={addWaits}
                onChange={(e) => setAddWaits(e.target.checked)}
              />
              智能等待
            </label>
          </div>

          <textarea
            className="export-code"
            value={exportedCode}
            onChange={(e) => setExportedCode(e.target.value)}
            placeholder={`预览生成的 ${exportFormat} 代码...`}
            readOnly
          />

          <div className="export-stats">
            <span>{traceEvents.length} 个事件</span>
            <span>{exportedCode.length} 字符</span>
          </div>
        </div>

        <div className="export-actions">
          <button className="btn btn-secondary" onClick={handleClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={generateCode}>
            生成代码
          </button>
          <button className="btn btn-success" onClick={handleCopy} disabled={!exportedCode}>
            复制
          </button>
          <button className="btn btn-success" onClick={handleDownload} disabled={!exportedCode}>
            下载
          </button>
        </div>
      </div>
    </div>
  );
}

export default ExportDialog;
