/**
 * Layout fixture for the settings page.
 *
 * The session-manager row is a grid, and the settings panel is narrow — barely
 * 470px — so a track list that looks fine on paper can still collapse the title
 * column to zero and push the actions past the right edge. This script lifts the
 * stylesheet straight out of `client.js` (no copy to drift), renders the same
 * markup the component builds with representative data, and writes
 * `dev/preview.html` at that narrow width.
 *
 * Open the result in a browser, or run it through a screenshot, to see what the
 * user sees. It is a fixture, not part of the plugin: nothing imports it.
 *
 * Run with `node dev/layout.mjs`.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'client.js'), 'utf8')

/** Pull one backtick template literal out of the source. */
function template(name) {
  const start = source.indexOf(`const ${name} = \``)
  if (start < 0) throw new Error(`client.js no longer defines ${name}`)
  const from = start + `const ${name} = \``.length
  const end = source.indexOf('`', from)
  if (end < 0) throw new Error(`${name} is not a plain template literal`)
  return source.slice(from, end)
}

const css = template('CSS')

// Theme tokens the plugin reads. The real app supplies them; here they are the
// light values so the fixture renders without the shell.
const tokens = `
:root{--dsw-alias-label-primary:#1b1b1f;--dsw-alias-label-secondary:#4a4a52;--dsw-alias-label-tertiary:#8a8a94;--dsw-alias-label-error:#d93025;--dsw-alias-link:#2f6feb;--dsw-alias-border-l2:rgba(0,0,0,.14);--dsw-alias-interactive-bg-hover:rgba(0,0,0,.05);--dsw-alias-interactive-bg-hover-danger:rgba(217,48,37,.08);--dsw-alias-state-business-primary:#2f6feb;--dsw-alias-state-warn-label:#9a6b00}
`

const rows = [
  { title: '讨论 dsh 插件体系的加载顺序与槽位注册', workspace: 'default-workspace', time: '2026/10/12 09:40', size: '586.0 KB' },
  { title: '今天的大模型并行训练与部署方案讨论', workspace: 'default-workspace', time: '2026/10/16 10:37', size: '250.9 KB' },
  { title: 'Clash 订阅导入 YAML 报错排查', workspace: 'default-workspace', time: '2026/10/12 11:19', size: '28.3 KB' },
  { title: '今天的日报给我', workspace: 'coffee-index-admin-ui', time: '2026/10/12 17:14', size: '267.6 KB' },
  { title: '检查本机是否安装 Redis', workspace: 'default-workspace', time: '2026/10/16 17:05', size: '147.0 KB' },
  { title: '日志已丢失的归档（用来检查标签与“丢弃条目”）', workspace: '', time: '2026/10/19 18:42', size: '', missing: true },
  { title: '', workspace: 'default-workspace', time: '2026/10/20 16:58', size: '243.6 KB', untitled: true },
]

/** One row, mirroring the component's element structure. */
function row(item) {
  const title = item.title.length > 0 ? item.title : item.missing === true ? '日志已丢失' : 'session-4f452ff0-7cd5-4d3d-9a74-d29664ce7164'
  const meta = [
    item.workspace.length > 0 ? `<span class="dcm-cell">${item.workspace}</span>` : '<span class="dcm-cell">未关联工作区</span>',
    '<span class="dcm-sep">·</span>',
    `<span class="dcm-cell">${item.time}</span>`,
    '<span class="dcm-sep">·</span>',
    `<span class="dcm-cell">${item.size.length > 0 ? item.size : '—'}</span>`,
    item.missing === true ? '<span class="dcm-tag">日志缺失</span>' : '',
  ].join('')
  const actions = item.missing === true
    ? '<button class="dcm-link">丢弃条目</button><button class="dcm-link">恢复</button><button class="dcm-link dcm-link-danger">删除</button>'
    : '<button class="dcm-link">查看</button><button class="dcm-link">恢复</button><button class="dcm-link dcm-link-danger">删除</button>'
  return `<li class="dcm-row">
  <input class="dcm-check" type="checkbox">
  <div class="dcm-main">
    <button class="dcm-title" data-empty="${item.title.length > 0 ? 'false' : 'true'}">${title}</button>
    <div class="dcm-meta">${meta}</div>
  </div>
  <span class="dcm-actions">${actions}</span>
</li>`
}

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-chat-manage · 会话管理布局预览</title>
<style>
${tokens}
body{margin:0;padding:24px;background:#f4f4f6;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
.panel{width:470px;padding:20px;background:#fff;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.08)}
.hint{margin:0 0 14px;font-size:12px;color:#8a8a94}
${css}
</style>
</head>
<body>
<div class="panel">
  <p class="hint">470px 宽的设置面板（真实面板约此宽度）</p>
  <div class="dcm-section">
    <h2 class="dcm-heading">会话管理</h2>
    <p class="dcm-intro">这里列出已归档的对话，可以查看内容、恢复到侧边栏，或者彻底删除。</p>
    <div class="dcm-toolbar">
      <input class="dcm-search" type="search" placeholder="搜索标题或工作区">
      <div class="dcm-toolbar-row">
        <button class="dcm-btn">刷新</button>
        <button class="dcm-btn">全选</button>
        <button class="dcm-btn" disabled>恢复所选</button>
        <button class="dcm-btn dcm-btn-danger" disabled>删除所选</button>
      </div>
    </div>
    <div class="dcm-head">
      <span></span>
      <span>对话</span>
      <span class="dcm-head-actions">操作</span>
    </div>
    <ul class="dcm-list">
${rows.map(row).join('\n')}
    </ul>
    <p class="dcm-foot">共 9 个归档对话 · 1.8 MB · 最近归档在前</p>
  </div>
</div>
</body>
</html>
`

const target = join(here, 'preview.html')
await writeFile(target, html, 'utf8')
console.log(`wrote ${target}`)
