/**
 * 导出对话框 - 支持导出为不同语言的代码
 */

import { useStore } from '../store/useStore';
import { useState } from 'react';

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

    traceEvents.forEach((event, index) => {
      code += `  // 步骤 ${index + 1}: ${event.type}\n`;
      if (event.type === 'open' && event.url) {
        code += `  await page.goto('${event.url}');\n`;
      } else if (event.type === 'click' && event.ref) {
        code += `  await page.click('[ref="${event.ref}"]');\n`;
      } else if (event.type === 'fill' && event.ref && event.value) {
        code += `  await page.fill('[ref="${event.ref}"]', '${event.value}');\n`;
      } else if (event.type === 'press' && event.key) {
        code += `  await page.press('${event.key}');\n`;
      }
    });

    code += '}\n';
    return code;
  };

  const generatePlaywright = () => {
    let code = '// Playwright 测试脚本\n';
    code += `import { test, expect } from '@playwright/test';\n\n`;
    code += `test('录制测试', async ({ page }) => {\n`;

    traceEvents.forEach((event, index) => {
      code += `  // ${event.type}\n`;
      if (event.type === 'open' && event.url) {
        code += `  await page.goto('${event.url}');\n`;
      } else if (event.type === 'click' && event.ref) {
        code += `  await page.getByTestId('ref-${event.ref}').click();\n`;
      } else if (event.type === 'fill' && event.ref && event.value) {
        code += `  await page.getByTestId('ref-${event.ref}').fill('${event.value}');\n`;
      } else if (event.type === 'press' && event.key) {
        code += `  await page.keyboard.press('${event.key}');\n`;
      }
    });

    code += '});\n';
    return code;
  };

  const generatePython = () => {
    let code = '# Selenium Python 脚本\n';
    code += `from selenium import webdriver\n\n`;
    code += `driver = webdriver.Chrome()\n\n`;

    traceEvents.forEach((event, index) => {
      if (event.type === 'open' && event.url) {
        code += `driver.get('${event.url}')\n`;
      } else if (event.type === 'click' && event.ref) {
        code += `driver.find_element(By.CSS_SELECTOR, '[ref="${event.ref}"]').click()\n`;
      } else if (event.type === 'fill' && event.ref && event.value) {
        code += `element = driver.find_element(By.CSS_SELECTOR, '[ref="${event.ref}"]')\n`;
        code += `element.clear()\n`;
        code += `element.send_keys('${event.value}')\n`;
      } else if (event.type === 'press' && event.key) {
        code += `from selenium.webdriver.common.keys import Keys\n`;
        code += `driver.send_keys(Keys.${event.key.toUpperCase()})\n`;
      }
    });

    code += `driver.quit()\n`;
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
