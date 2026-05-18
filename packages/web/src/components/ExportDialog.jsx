/**
 * 导出对话框 - 支持导出为不同语言的代码
 */

import { useStore } from '../store/useStore';
import { useState } from 'react';

/** Escape single quotes for embedding in JS/Python strings. */
function esc(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

/**
 * Return the best available CSS selector for a trace event.
 * Priority: ref attribute > cssSelector > xpath (wrapped in comment).
 */
function bestSelector(event) {
  if (event.ref) return `[ref="${event.ref}"]`;
  if (event.cssSelector) return event.cssSelector;
  return null;
}

function ExportDialog() {
  const { showExporter, setShowExporter, traceEvents, activeTab } = useStore();
  const [exportFormat, setExportFormat] = useState('javascript');
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

  const generateJavaScript = () => {
    let code = '// 自动生成的录制脚本\n';
    code += `// URL: ${activeTab?.url || 'N/A'}\n`;
    code += `// 生成时间: ${new Date().toLocaleString()}\n\n`;
    code += 'async function run() {\n';

    // Navigation: always start with the recorded page URL
    if (activeTab?.url) {
      code += `  await page.goto('${esc(activeTab.url)}');\n`;
    }

    traceEvents.forEach((event, index) => {
      code += `  // 步骤 ${index + 1}: ${event.type}\n`;
      const sel = bestSelector(event);
      if (event.type === 'click' && sel) {
        code += `  await page.click('${esc(sel)}');\n`;
      } else if (event.type === 'fill' && sel && event.value) {
        code += `  await page.fill('${esc(sel)}', '${esc(event.value)}');\n`;
      } else if (event.type === 'select' && sel && event.value) {
        code += `  await page.selectOption('${esc(sel)}', '${esc(event.value)}');\n`;
      } else if (event.type === 'check' && sel) {
        code += `  await page.check('${esc(sel)}');\n`;
      } else if (event.type === 'press' && event.key) {
        code += `  await page.keyboard.press('${esc(event.key)}');\n`;
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
    let code = '// Playwright 测试脚本\n';
    code += `import { test, expect } from '@playwright/test';\n\n`;
    code += `test('录制测试', async ({ page }) => {\n`;

    // Navigation
    if (activeTab?.url) {
      code += `  await page.goto('${esc(activeTab.url)}');\n`;
    }

    traceEvents.forEach((event, index) => {
      code += `  // ${event.type}\n`;
      const sel = bestSelector(event);
      if (event.type === 'click' && sel) {
        code += `  await page.locator('${esc(sel)}').click();\n`;
      } else if (event.type === 'fill' && sel && event.value) {
        code += `  await page.locator('${esc(sel)}').fill('${esc(event.value)}');\n`;
      } else if (event.type === 'select' && sel && event.value) {
        code += `  await page.locator('${esc(sel)}').selectOption('${esc(event.value)}');\n`;
      } else if (event.type === 'check' && sel) {
        code += `  await page.locator('${esc(sel)}').check();\n`;
      } else if (event.type === 'press' && event.key) {
        code += `  await page.keyboard.press('${esc(event.key)}');\n`;
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
    let code = '# Selenium Python 脚本\n';
    code += `from selenium import webdriver\n`;
    code += `from selenium.webdriver.common.by import By\n`;
    code += `from selenium.webdriver.common.keys import Keys\n`;
    code += `from selenium.webdriver.support.ui import WebDriverWait\n`;
    code += `from selenium.webdriver.support import expected_conditions as EC\n\n`;
    code += `driver = webdriver.Chrome()\n`;
    code += `wait = WebDriverWait(driver, 10)\n\n`;

    // Navigation
    if (activeTab?.url) {
      code += `driver.get('${esc(activeTab.url)}')\n\n`;
    }

    traceEvents.forEach((event, index) => {
      const sel = bestSelector(event);
      if (event.type === 'click' && sel) {
        code += `driver.find_element(By.CSS_SELECTOR, '${esc(sel)}').click()\n`;
      } else if (event.type === 'fill' && sel && event.value) {
        code += `el = driver.find_element(By.CSS_SELECTOR, '${esc(sel)}')\n`;
        code += `el.clear()\n`;
        code += `el.send_keys('${esc(event.value)}')\n`;
      } else if (event.type === 'select' && sel && event.value) {
        code += `from selenium.webdriver.support.ui import Select\n`;
        code += `Select(driver.find_element(By.CSS_SELECTOR, '${esc(sel)}')).select_by_value('${esc(event.value)}')\n`;
      } else if (event.type === 'check' && sel) {
        code += `el = driver.find_element(By.CSS_SELECTOR, '${esc(sel)}')\n`;
        code += `if not el.is_selected(): el.click()\n`;
      } else if (event.type === 'press' && event.key) {
        code += `from selenium.webdriver.common.action_chains import ActionChains\n`;
        code += `ActionChains(driver).send_keys(Keys.${event.key.toUpperCase()}).perform()\n`;
      } else if (event.type === 'scroll') {
        const dir = event.direction || 'down';
        const px = event.pixels || 300;
        const y = dir === 'up' ? -px : px;
        code += `driver.execute_script('window.scrollBy(0, ${y})')\n`;
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
