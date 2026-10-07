import { useMemo, useState } from 'react';
import { groupHelpEntries, HELP_ENTRIES, HELP_OTHER_LABEL, type HelpEntry } from './helpData.js';

/**
 * 内建帮助面板（UI-08）：原版繁体中文说明，按编号区间分类分组，支持关键字过滤。
 * 文案保持原样不转换简繁，避免破坏原始资料的可追溯性。
 */
export function HelpPanel({ onClose }: { onClose?: () => void }) {
  const [keyword, setKeyword] = useState('');

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return HELP_ENTRIES;
    // 编号也要能被搜到，例如输入 "08"
    return HELP_ENTRIES.filter(
      (e) => String(e.no).padStart(2, '0').includes(kw) || e.paragraphs.some((p) => p.toLowerCase().includes(kw)),
    );
  }, [keyword]);

  const { groups, other } = useMemo(() => groupHelpEntries(filtered), [filtered]);
  const total = filtered.length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card help-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="panel-title">帮助（UI-08）</span>
          <button className="ghost small" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="help-filter">
          <input
            placeholder="输入关键字过滤条目…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <span className="help-count">{total} / {HELP_ENTRIES.length} 条</span>
        </div>

        <div className="help-list">
          {total === 0 && <div className="empty-hint">没有匹配的条目</div>}
          {groups
            .filter((g) => g.entries.length > 0)
            .map((g) => (
              <HelpGroup key={g.key} label={g.label} entries={g.entries} />
            ))}
          {other.length > 0 && <HelpGroup label={HELP_OTHER_LABEL} entries={other} />}
        </div>
      </div>
    </div>
  );
}

function HelpGroup({ label, entries }: { label: string; entries: HelpEntry[] }) {
  return (
    <div className="help-group">
      <div className="help-group-title">{label}</div>
      {entries.map((e) => (
        <div key={e.no} className="help-item">
          <span className="help-no">[{String(e.no).padStart(2, '0')}]</span>
          <div className="help-body">
            {e.paragraphs.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}