/**
 * 标签页管理面板
 */

import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { daemon } from '../api/daemon';

function TabPanel() {
  const { tabs, activeTab, activeTabId, setTabs, setActiveTab } = useStore();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const response = await daemon.send('tab_list');
      if (response.success && response.data.tabs) {
        setTabs(response.data.tabs);
      }
    } catch (err) {
      console.error('Failed to refresh tabs:', err);
    } finally {
      setRefreshing(false);
    }
  };

  const handleSelectTab = (tab) => {
    setActiveTab(tab, tab.tabId);
  };

  return (
    <div className="tab-panel">
      <div className="panel-header">
        <h3>标签页</h3>
        <button
          className="btn-icon"
          onClick={handleRefresh}
          disabled={refreshing}
          title="刷新"
        >
          {refreshing ? '⟳' : '↻'}
        </button>
      </div>
      <div className="tab-list">
        {tabs.length === 0 ? (
          <div className="empty-state">无标签页</div>
        ) : (
          tabs.filter(tab => tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))).map((tab, index) => (
            <div
              key={tab.tabId}
              className={`tab-item ${tab.tabId === activeTabId ? 'active' : ''}`}
              onClick={() => handleSelectTab(tab)}
            >
              <div className="tab-icon">🌐</div>
              <div className="tab-info">
                <div className="tab-title">{tab.title || tab.url}</div>
                <div className="tab-url">{tab.url}</div>
              </div>
              {tab.tabId === activeTabId && (
                <div className="tab-active-indicator">●</div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default TabPanel;
