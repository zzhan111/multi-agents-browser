import { useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import { daemon } from '../api/daemon';
import ConnectionPanel from './ConnectionPanel';
import TabPanel from './TabPanel';
import TraceControls from './TraceControls';
import TraceTimeline from './TraceTimeline';
import RealtimeMonitor from './RealtimeMonitor';
import ExportDialog from './ExportDialog';

function TraceStudio() {
  const {
    connected,
    connectionError,
    setConnected,
    setConnecting,
    setConnectionError,
    setTabs,
    setActiveTab,
    traceRecording,
    setTraceRecording,
    setTraceEvents,
    addTraceEvent,
    lastUpdated,
  } = useStore();

  const lastEventCursorRef = useRef(null);

  // 监听 daemon 连接状态
  useEffect(() => {
    const handleConnected = () => {
      setConnected(true);
      setConnecting(false);
      setConnectionError(null);
      loadTabs();
    };

    const handleDisconnected = () => {
      setConnected(false);
      setConnectionError('连接已断开');
    };

    const handleError = (error) => {
      setConnectionError(error.message || '连接错误');
      setConnecting(false);
    };

    daemon.on('connected', handleConnected);
    daemon.on('disconnected', handleDisconnected);
    daemon.on('error', handleError);

    return () => {
      daemon.off('connected', handleConnected);
      daemon.off('disconnected', handleDisconnected);
      daemon.off('error', handleError);
    };
  }, [setConnected, setConnecting, setConnectionError, setTabs]);

  // 录制中：轮询增量 trace 事件
  useEffect(() => {
    if (!traceRecording || !connected) return;

    const interval = setInterval(async () => {
      try {
        const response = await daemon.send('trace', {
          traceCommand: 'events',
          since: lastEventCursorRef.current,
        });
        if (response.success) {
          const events = response.data.traceEvents || [];
          for (const event of events) {
            addTraceEvent(event);
          }
          if (response.cursor !== undefined) {
            lastEventCursorRef.current = response.cursor;
          }
          // 如果后端停止了录制（例如页面导航导致），同步状态
          if (response.data.traceStatus && !response.data.traceStatus.recording) {
            setTraceRecording(false);
          }
        }
      } catch (err) {
        console.error('Failed to poll trace events:', err);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [traceRecording, connected, setTraceRecording, addTraceEvent]);

  // 加载标签页列表
  const loadTabs = async () => {
    try {
      const response = await daemon.send('tab_list');
      if (response.success && response.data.tabs) {
        setTabs(response.data.tabs);
        const activeTab = response.data.tabs.find(t => t.active);
        if (activeTab) {
          setActiveTab(activeTab, activeTab.tabId);
        }
      }
    } catch (err) {
      console.error('Failed to load tabs:', err);
    }
  };

  return (
    <div className="trace-studio">
      <header className="studio-header">
        <h1 className="studio-title">BB Browser Trace Studio</h1>
        <ConnectionPanel />
      </header>

      {!connected ? (
        <div className="connection-banner status-warning">
          <span className="status-icon">⚠️</span>
          <span>{connectionError || '未连接到 daemon'}</span>
        </div>
      ) : (
        <>
          <div className="studio-banner status-success">
            <span className="status-icon">✓</span>
            <span>已连接到 daemon</span>
          </div>

          <div className="studio-content">
            <aside className="sidebar">
              <TabPanel />
              <RealtimeMonitor />
            </aside>

            <main className="main-panel">
              <div className="controls-section">
                <TraceControls />
              </div>

              <div className="events-section">
                {traceRecording && (
                  <div className="recording-indicator">
                    <span className="recording-dot"></span>
                    <span>正在录制中...</span>
                    <span className="event-count">({lastUpdated ? '最近更新' : '等待操作'})</span>
                  </div>
                )}
                <TraceTimeline />
              </div>
            </main>
          </div>
        </>
      )}

      <ExportDialog />
    </div>
  );
}

export default TraceStudio;
