/**
 * TracePage — 控制面板 Trace tab
 *
 * 完整迁移自 packages/web/src/components/TraceStudio.jsx，
 * 仅调整：
 *   1. 导入路径（相对于 src-panel/src/pages/）
 *   2. 移除独立 daemon.connect() 调用（Dashboard 已在 mount 时连接）
 *   3. 标题行简化（控制面板已有 TabBar）
 */

import { useEffect, useRef } from 'react';
import { useStore } from '../store/useStore.jsx';
import { daemon } from '../api/daemon.js';
import TabPanel from '../components/TabPanel.jsx';
import TraceControls from '../components/TraceControls.jsx';
import TraceTimeline from '../components/TraceTimeline.jsx';
import RealtimeMonitor from '../components/RealtimeMonitor.jsx';
import CommandLog from '../components/CommandLog.jsx';
import ExportDialog from '../components/ExportDialog.jsx';

import styles from './TracePage.module.css';

export default function TracePage() {
  const {
    connected,
    connectionError,
    setConnected,
    setConnecting,
    setConnectionError,
    setTabs,
    setActiveTab,
    activeTab,
    traceRecording,
    setTraceRecording,
    setTraceEvents,
    addTraceEvent,
    lastUpdated,
    commands,
    setCommands,
    recordWindow,
    setRecordWindow,
  } = useStore();

  const lastEventCursorRef = useRef(null);

  // 监听 daemon 连接状态
  useEffect(() => {
    const onConnected = () => {
      setConnected(true);
      setConnecting(false);
      setConnectionError(null);
      loadTabs();
    };
    const onDisconnected = () => {
      setConnected(false);
      setConnectionError('连接已断开');
    };
    const onError = (err) => {
      setConnectionError(err?.message || '连接错误');
      setConnecting(false);
    };

    daemon.on('connected', onConnected);
    daemon.on('disconnected', onDisconnected);
    daemon.on('error', onError);

    // If already connected when we mount, fire onConnected immediately.
    if (daemon.isConnected()) onConnected();

    return () => {
      daemon.off('connected', onConnected);
      daemon.off('disconnected', onDisconnected);
      daemon.off('error', onError);
    };
  }, [setConnected, setConnecting, setConnectionError]);

  // Reset cursor only when recording flips false→true; stamp the record window
  // (used to highlight which MCP commands fall inside the recording span).
  const wasRecordingRef = useRef(false);
  const recordWindowRef = useRef(recordWindow);
  recordWindowRef.current = recordWindow;
  useEffect(() => {
    if (traceRecording && !wasRecordingRef.current) {
      lastEventCursorRef.current = null;
      setRecordWindow({ start: Date.now(), end: null });
    } else if (!traceRecording && wasRecordingRef.current) {
      const rw = recordWindowRef.current;
      if (rw.start != null) setRecordWindow({ ...rw, end: Date.now() });
    }
    wasRecordingRef.current = traceRecording;
  }, [traceRecording, setRecordWindow]);

  // Poll the daemon command history (incremental via since=seq).
  const lastCommandSeqRef = useRef(0);
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await daemon.getCommands(100, lastCommandSeqRef.current);
        if (!cancelled && res?.commands?.length) {
          const cmds = res.commands;
          const maxSeq = cmds.reduce((m, c) => Math.max(m, c.seq), 0);
          if (maxSeq > lastCommandSeqRef.current) lastCommandSeqRef.current = maxSeq;
          setCommands((prev) => {
            // Merge: keep old commands not in the new batch, append new ones
            const existingSeqs = new Set(cmds.map((c) => c.seq));
            const merged = [...prev.filter((c) => !existingSeqs.has(c.seq)), ...cmds];
            // Keep newest first, cap at 200
            merged.sort((a, b) => b.seq - a.seq);
            return merged.slice(0, 200);
          });
        }
      } catch (err) {
        console.error('[TracePage] commands poll error:', err);
      }
    };
    poll();
    const t = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(t); };
  }, [connected, setCommands]);

  // Recording poll (Web Worker timer to avoid throttling when tab is hidden).
  useEffect(() => {
    if (!traceRecording || !connected) return;

    const workerSrc = `
      let id = null;
      self.onmessage = (e) => {
        if (e.data === 'start' && id === null) id = setInterval(() => self.postMessage('tick'), 1000);
        else if (e.data === 'stop' && id !== null) { clearInterval(id); id = null; }
      };
    `;
    const worker = new Worker(
      URL.createObjectURL(new Blob([workerSrc], { type: 'application/javascript' })),
    );

    let cancelled = false;
    let inFlight = false;

    const pollOnce = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const res = await daemon.send('trace', {
          traceCommand: 'events',
          tabId: activeTab?.tabId,
          since: lastEventCursorRef.current,
        });
        if (cancelled) return;
        if (res.success) {
          for (const ev of res.data.traceEvents ?? []) addTraceEvent(ev);
          if (res.data.cursor !== undefined) lastEventCursorRef.current = res.data.cursor;
          if (res.data.traceStatus && !res.data.traceStatus.recording) setTraceRecording(false);
        }
      } catch (err) {
        console.error('[TracePage] poll error:', err);
      } finally {
        inFlight = false;
      }
    };

    worker.onmessage = pollOnce;
    worker.postMessage('start');
    pollOnce();

    return () => {
      cancelled = true;
      worker.postMessage('stop');
      worker.terminate();
    };
  }, [traceRecording, connected, activeTab, setTraceRecording, addTraceEvent]);

  const loadTabs = async () => {
    try {
      const res = await daemon.send('tab_list');
      if (res.success && res.data.tabs) {
        const tabs = res.data.tabs;
        setTabs(tabs);
        const recordable = (t) => t.url?.startsWith('http://') || t.url?.startsWith('https://');
        const target = (tabs.find((t) => t.active && recordable(t))) ?? tabs.find(recordable);
        if (target) setActiveTab(target, target.tabId);
      }
    } catch (err) {
      console.error('[TracePage] load tabs error:', err);
    }
  };

  return (
    <div className={styles.root}>
      {!connected ? (
        <div className={styles.banner} data-status="warning">
          <span>⚠️</span>
          <span>{connectionError || '未连接到 daemon'}</span>
        </div>
      ) : (
        <>
          <div className={styles.banner} data-status="success">
            <span>✓</span>
            <span>已连接到 daemon</span>
          </div>

          <div className={styles.body}>
            <aside className={styles.sidebar}>
              <TabPanel />
              <RealtimeMonitor />
            </aside>

            <main className={styles.main}>
              <div className={styles.controls}>
                <TraceControls />
              </div>
              <div className={styles.split}>
                <div className={styles.commandPane}>
                  <CommandLog
                    commands={commands}
                    tabShort={activeTab?.tab}
                    recordWindow={recordWindow}
                  />
                </div>
                <div className={styles.timeline}>
                  {traceRecording && (
                    <div className={styles.recordingIndicator}>
                      <span className={styles.recDot} />
                      <span>正在录制中…</span>
                      <span className={styles.recNote}>
                        {lastUpdated ? '最近有更新' : '等待操作'}
                      </span>
                    </div>
                  )}
                  <TraceTimeline />
                </div>
              </div>
            </main>
          </div>
        </>
      )}

      <ExportDialog />
    </div>
  );
}
