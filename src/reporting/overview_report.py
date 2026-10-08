"""单页总览骨架（供各菜单报告接入）。

职责：左侧菜单、面板章节容器、锚点路由与滚动联动，以及页面级样式骨架。
菜单报告以 {id, label, group, html} 描述自身：id 即页内锚点，group 决定侧栏
分组（按首次出现顺序），html 为章节面板内容。新增菜单（如 S-001 静态质量、
后续评测维度）只需在 menus 中追加一项，无需改动页面骨架。
"""

import json
from pathlib import Path

from pyautorun.reporting.html import esc, page_shell


# 页面级样式骨架：布局、面板容器、区块标题、侧栏。
OVERVIEW_EXTRA_HEAD = """<style>
  /* 单页报告：平滑滚动定位 + 章节滚动边距 */
  html { scroll-behavior: smooth; }
  .l1-section { scroll-margin-top: 16px; }
  .l1-section + .l1-section { border-top: 1px solid var(--border); margin-top: 30px; padding-top: 24px; }
  /* 区块标题：左侧竖线 + 靛蓝字色 */
  .l1-h2-bar { color: #312e81; border-left: 4px solid #4338ca; padding-left: 10px; }
  /* 区块面板容器：白底卡片，内部小卡片浅灰底；相邻面板去掉分隔线，间距由 margin-bottom 承担 */
  .l1-panel { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 18px 20px; margin-bottom: 16px; box-shadow: 0 1px rgba(0,0,0,.04); }
  .l1-panel + .l1-panel { border-top: 1px solid #e2e8f0; margin-top: 0; padding-top: 0; }
  .l1-panel .l1-h2-bar { margin-top: 0; }
  .l1-panel h2:first-child, .l1-panel h3:first-child { margin-top: 0; }
  .l1-panel > :last-child { margin-bottom: 0; }
  .l1-panel .stat, .l1-panel .l1-stat { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px; box-shadow: none; }
  /* 左侧导航：页面主内容区变为「侧边菜单 + 内容」两栏 */
  .wrap { display: flex; align-items: flex-start; gap: 24px; }
  .l1-sidebar {
    flex: 0 0 230px; position: sticky; top: 24px; max-height: calc(100vh - 48px);
    overflow-y: auto; background: var(--card); border: 1px solid var(--border);
    border-radius: 10px; padding: 12px 0; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
  }
  .l1-side-brand { padding: 6px 16px 10px; font-size: 14px; font-weight: 650; border-bottom: 1px solid var(--border); margin-bottom: 8px; }
  .l1-side-group { padding: 10px 16px 4px; color: var(--muted); font-size: 12px; font-weight: 600; }
  .l1-side-item {
    display: block; padding: 8px 16px 8px 26px; color: var(--text); font-size: 13px;
    text-decoration: none; border-left: 3px solid transparent; word-break: break-all;
  }
  .l1-side-item:hover { background: #f3f5f8; }
  .l1-side-item.active { background: var(--accent-soft); color: var(--accent); border-left-color: var(--accent); font-weight: 600; }
  .l1-content { flex: 1 1 auto; min-width: 0; }
  @media (max-width: 960px) {
    .wrap { display: block; }
    .l1-sidebar { position: static; max-height: none; margin-bottom: 20px; }
  }
</style>"""


def overview_scroll_spy_script(default_id=""):
    """滚动联动：观察各章节，进入视口即高亮对应菜单项；点击菜单（或直接改 hash）立即切换。"""
    return f"""<script>
(function () {{
  var links = Array.prototype.slice.call(document.querySelectorAll('.l1-side-item'));
  var byHash = {{}};
  links.forEach(function (link) {{ byHash[link.getAttribute('href').slice(1)] = link; }});
  function setActive(id) {{
    links.forEach(function (link) {{ link.classList.remove('active'); }});
    if (byHash[id]) byHash[id].classList.add('active');
  }}
  var sections = Array.prototype.slice.call(document.querySelectorAll('[data-l1-section]'));
  if ('IntersectionObserver' in window) {{
    var observer = new IntersectionObserver(function (entries) {{
      var visible = entries.filter(function (entry) {{ return entry.isIntersecting; }})
        .sort(function (a, b) {{ return a.boundingClientRect.top - b.boundingClientRect.top; }});
      if (visible[0]) setActive(visible[0].target.id);
    }}, {{ rootMargin: '-15% 0px -70% 0px', threshold: 0 }});
    sections.forEach(function (section) {{ observer.observe(section); }});
  }}
  // 点击菜单（或直接改 hash）时立即切换高亮，不等待滚动事件
  window.addEventListener('hashchange', function () {{
    var id = location.hash.slice(1);
    if (byHash[id]) setActive(id);
  }});
  var initial = location.hash ? location.hash.slice(1) : '{esc(default_id)}';
  if (byHash[initial]) setActive(initial);
}})();
</script>"""


def overview_sidebar(title, menus):
    """左侧导航：按菜单 group 分组（保持首次出现顺序），当前章节高亮由滚动脚本驱动。"""
    groups = []
    for menu in menus:
        group = next((item for item in groups if item["name"] == menu["group"]), None)
        if not group:
            group = {"name": menu["group"], "items": []}
            groups.append(group)
        group["items"].append(menu)
    parts = [f'<aside class="l1-sidebar">\n    <div class="l1-side-brand">{esc(title)}</div>']
    for group in groups:
        parts.append(f'\n    <div class="l1-side-group">{esc(group["name"])}</div>')
        parts.append("\n    ".join(f'<a class="l1-side-item" href="#{esc(menu["id"])}">'
                                   f'{esc(menu["label"])}</a>' for menu in group["items"]))
    parts.append("\n  </aside>")
    return "".join(parts)


def build_overview_body(title, menus):
    """组装单页主体：每个菜单渲染为一个面板章节，章节 id 即锚点。"""
    sections = "\n".join(f'<section class="l1-section l1-panel" id="{esc(menu["id"])}" '
                         f'data-l1-section>{menu["html"]}</section>' for menu in menus)
    return (f'{overview_sidebar(title, menus)}<div class="l1-content">\n{sections}\n  </div>'
            f'{overview_scroll_spy_script(menus[0]["id"] if menus else "")}')


def write_overview_report(run_root, title, run_id, menus, dir_name="overview",
                          extra_head="", data=None, data_file_name=""):
    """写出单页总览：index.html（页面骨架 + 各菜单章节）与可选的机器可读数据文件。

    旧版分散的 HTML 产物在此一并清理，避免与单页报告共存造成混淆。
    """
    out_dir = Path(run_root) / dir_name
    out_dir.mkdir(parents=True, exist_ok=True)
    for entry in out_dir.iterdir():
        if entry.suffix == ".html" and entry.name != "index.html":
            entry.unlink(missing_ok=True)
    index_page_path = out_dir / "index.html"
    index_page_path.write_text(page_shell(f"{title} · {run_id}",
                                          build_overview_body(title, menus),
                                          extra_head=OVERVIEW_EXTRA_HEAD + extra_head),
                               encoding="utf-8")
    data_path = ""
    if data is not None and data_file_name:
        data_path = str(out_dir / data_file_name)
        Path(data_path).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                                   encoding="utf-8")
    return {"indexPagePath": str(index_page_path), "dataPath": data_path}
