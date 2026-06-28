/**
 * AdapterConsentModal — 社区适配器免责声明模态
 *
 * 用户首次点"获取社区适配器"时弹出。展示法律免责要点(基于 ma-browser
 * 法律定性调研报告 §4-A),用户点"我已阅读并同意"才会触发 git clone。
 *
 * 为什么需要显式同意:报告红线指出"默认即开即用 adapter 库削弱技术中立
 * 抗辩"——必须把工具(ma-browser)与内容(社区 adapter)责任切割,并让用户
 * 显式承担合规责任,才能保留"用户行为自动化"的法律定性。
 */

import styles from './AdapterConsentModal.module.css';

export default function AdapterConsentModal({ open, loading, onAgree, onCancel }) {
  if (!open) return null;
  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.title}>社区适配器免责声明</h2>

        <p className={styles.intro}>
          ma-browser 是本地自动化工具,不运营数据服务、不聚合数据、不做内容缓存。
          社区适配器由各自作者独立维护,ma-browser 不为适配器行为背书。
        </p>

        <p className={styles.sectionLabel}>使用适配器时你需自行确保:</p>
        <ul className={styles.list}>
          <li>遵守目标站点的服务条款(ToS)与 robots 协议</li>
          <li>不用于反爬、验证码、风控绕过</li>
          <li>不大规模爬取、转售或用于商业化替代服务</li>
          <li>不违反《反不正当竞争法》《数据安全法》《个人信息保护法》</li>
        </ul>

        <p className={styles.footer}>
          你对适配器的合规性、数据合法性负全部责任。
        </p>

        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onCancel} disabled={loading}>
            取消
          </button>
          <button className={styles.agreeBtn} onClick={onAgree} disabled={loading}>
            {loading ? '正在获取…' : '我已阅读并同意,获取社区适配器'}
          </button>
        </div>
      </div>
    </div>
  );
}
