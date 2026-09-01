ma-browser 浏览器代理 — 快速开始
================================

1. 解压本 zip 到任意目录(无需安装,无需管理员)

2. 双击 ma-browser-tray.exe
   - 首次运行如提示缺少 WebView2,点"确定"自动安装,装完重新双击 exe
   - 托盘图标变绿 = 一切就绪

3. 需要 Google Chrome 浏览器(用于复用你的登录态)
   - 没装? 下载: https://www.google.com/chrome/

4. 配置你的 AI 客户端(Claude Code / Cursor / Cline),两种方式:
   方式 A(推荐,让 AI 自动配置):
     告诉你的 AI:"用 ma-browser,配置文件在 <解压目录>\mcp-config.json"
     AI 会读取该文件并自行配置 MCP。
   方式 B(手动):
     右键托盘 → "复制 MCP 配置" → 粘贴到你 AI 客户端的配置文件
   注意:接入前确保托盘图标为绿色(daemon 运行中)。

5. 日志与状态:
   - 托盘右键 → 打开日志
   - 状态目录: %USERPROFILE%\.bb-browser\

6. 更新:
   - 有新版本时,右键托盘菜单会显示 "🆕 有新版本 vX.Y.Z"
   - 点击该项打开下载页,下载新 zip
   - 退出当前程序(右键→退出),解压新 zip 替换整个目录,重新双击 exe

卸载: 删除整个解压目录即可(不写注册表)

注: 首次运行 Windows SmartScreen 可能提示"已保护你的电脑",
点"更多信息"→"仍要运行"即可(本程序未购买代码签名证书)。
