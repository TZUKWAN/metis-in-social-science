/**
 * SectionGroup — 设置页共享分组布局（UI 统一重构阶段）。
 *
 * 设计标准（任务文档第十节 Settings）：设置页禁止 Card Wall，分组一律用
 * section（标题 + 描述 + 控件 + 分隔线）结构：
 *   - 标题 14px / 600（13-15px 区间），描述 13px 次级文字
 *   - 控件区内 label 与控件左对齐成列
 *   - 分组分隔线 1px var(--ds-border)；最后一个分组不带分隔线
 * 本组件只负责布局容器与分组样式，不承载任何业务逻辑。
 */
import { useId } from 'react';
import type { ReactNode } from 'react';
import './settings.css';

export interface SectionGroupProps {
  /** 分组标题（14px / 600）。 */
  title: ReactNode;
  /** 标题上方的小号分类词（可选，如「连接」「成果」）。 */
  kicker?: ReactNode;
  /** 标题下的说明文字（13px 次级色）。 */
  description?: ReactNode;
  /** 标题行右侧控件（状态徽标 / 主操作按钮等），不参与换行。 */
  action?: ReactNode;
  /** 分组内容：label/control 行、编辑器、按钮组等。 */
  children: ReactNode;
  /** 附加类名（保留各 section 原有样式钩子，如 provider-profiles）。 */
  className?: string;
  /** 透传到根元素上的 data-testid。 */
  testId?: string;
}

export function SectionGroup({ title, kicker, description, action, children, className, testId }: SectionGroupProps) {
  const headingId = useId();
  const classes = className ? `ds-section ${className}` : 'ds-section';
  return (
    <section className={classes} aria-labelledby={headingId} data-testid={testId}>
      <header className="ds-section__heading">
        <div className="ds-section__heading-text">
          {kicker ? <p className="ds-section__kicker">{kicker}</p> : null}
          <h3 id={headingId} className="ds-section__title">{title}</h3>
          {description ? <p className="ds-section__desc">{description}</p> : null}
        </div>
        {action ? <div className="ds-section__action">{action}</div> : null}
      </header>
      <div className="ds-section__body">{children}</div>
    </section>
  );
}

export default SectionGroup;
