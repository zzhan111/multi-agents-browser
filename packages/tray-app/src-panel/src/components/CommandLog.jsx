/**
 * CommandLog — 当前标签页的最近 MCP 命令流
 *
 * 与 trace 事件时间线不同：这里展示的是 daemon command-history（GET /api/commands）
 * 里、解析到当前标签页（短 id）的命令，持续滚动、不随录制开始而清空。
 *
 * 录制只在这条连续流上打两个戳（▶ 开始 / ⏹ 结束）：落在戳之间的命令被高亮为
 * “已录制”，但导出仍走原 trace 事件管线，本视图不参与导出。
 */

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

function clockTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function statusIcon(status) {
  if (status === 'ok') return '✓';
  if (status === 'error') return '✗';
  return '…';
}

export default function CommandLog({ commands, tabShort, recordWindow }) {
  // 仅展示解析到当前标签页的命令（命令记录里的短 id 与 tab_list 的 .tab 一致）。
  const filtered = tabShort ? commands.filter((c) => c.tab === tabShort) : [];

  const { start, end } = recordWindow;
  const inWindow = (ts) =>
    start != null && ts >= start && (end == null || ts <= end);

  // 把命令与两个录制戳合并，按时间倒序（最新在上）渲染。
  const items = filtered.map((c) => ({ kind: 'cmd', ts: c.ts, cmd: c }));
  if (start != null) items.push({ kind: 'start', ts: start });
  if (end != null) items.push({ kind: 'end', ts: end });
  items.sort((a, b) => b.ts - a.ts);

  return (
    <div className="cmdlog">
      <div className="cmdlog-header">
        <span className="cmdlog-title">最近 MCP 命令</span>
        <span className="cmdlog-scope">
          {tabShort ? `当前标签页 ${tabShort}` : '未选择标签页'}
        </span>
        <span className="cmdlog-count">{filtered.length} 条</span>
      </div>

      <div className="cmdlog-list">
        {!tabShort ? (
          <div className="cmdlog-empty">请选择一个标签页</div>
        ) : items.length === 0 ? (
          <div className="cmdlog-empty">该标签页暂无命令记录</div>
        ) : (
          items.map((item, i) => {
            if (item.kind === 'start') {
              return (
                <div key={`mark-start`} className="cmdlog-mark cmdlog-mark--start">
                  <span className="cmdlog-mark-icon">▶</span>
                  <span className="cmdlog-mark-text">录制开始</span>
                  <span className="cmdlog-mark-time">{clockTime(item.ts)}</span>
                </div>
              );
            }
            if (item.kind === 'end') {
              return (
                <div key={`mark-end`} className="cmdlog-mark cmdlog-mark--end">
                  <span className="cmdlog-mark-icon">⏹</span>
                  <span className="cmdlog-mark-text">录制结束</span>
                  <span className="cmdlog-mark-time">{clockTime(item.ts)}</span>
                </div>
              );
            }
            const cmd = item.cmd;
            const recorded = inWindow(cmd.ts);
            return (
              <div
                key={`cmd-${cmd.seq}`}
                className={`cmdlog-row ${recorded ? 'cmdlog-row--recorded' : ''}`}
                title={recorded ? '此命令在录制窗口内' : undefined}
              >
                <span className={`cmdlog-status cmdlog-status--${cmd.status}`}>
                  {statusIcon(cmd.status)}
                </span>
                <span className="cmdlog-tool">{cmd.tool}</span>
                {cmd.argsSummary && <span className="cmdlog-args">{cmd.argsSummary}</span>}
                {recorded && <span className="cmdlog-rec-badge">● 录制</span>}
                <span className="cmdlog-time">{clockTime(cmd.ts)}</span>
                {cmd.durationMs > 0 && <span className="cmdlog-dur">{cmd.durationMs}ms</span>}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
