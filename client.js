/**
 * dsh-chat-manage — browser half.
 *
 * Three registrations, each gated by the slot it lands in:
 *
 *   - `sidebar.workspaces.session.menu.item` puts a 删除对话 row next to the
 *     official pin / rename / fork / archive rows. The slot hands us the session
 *     id and the displayed title, nothing else.
 *   - `shell.overlay` raises the confirmation dialog. It has to live in an
 *     overlay slot rather than inside the menu row: selecting a menu item closes
 *     the menu, which unmounts the row and would take an inline dialog with it.
 *   - `settings.section` adds the 会话管理 page, which reads the archive set back,
 *     previews a conversation, restores it, or deletes it.
 *
 * The Host half owns all reads and writes (`sessions.js`), so this file is only
 * presentation plus two small pieces of coordination: navigating away from a
 * conversation that is about to be deleted, and refreshing the sidebar list once
 * the Host has removed the artifact.
 *
 * Plain CJS with `React.createElement` — no build step, no JSX.
 */

window.__ModuleLoader__.load({
  id: 'dsh-chat-manage',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const UI = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'chatManage'

    /** Route prefix served by the Host half. */
    const PREFIX = '/dsh-chat-manage'

    /** The sidebar row menu. */
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'

    /** The settings page's section list. */
    const SECTION_SLOT = 'settings.section'

    /** Root overlay layer for dialogs that outlive their trigger. */
    const OVERLAY_SLOT = 'shell.overlay'

    /** Navigation entry id. Sorts after 通用 (0), before 模型 (10) and 插件 (15). */
    const SECTION_ID = 'session-manage'

    /** Sorts 会话管理 right after 通用: both are housekeeping, not configuration. */
    const SECTION_ORDER = 5

    /** Menu row id and order: last, because it is the destructive one. */
    const MENU_ID = 'chat-manage-delete'
    const MENU_ORDER = 500

    /** How long to wait after leaving a conversation before asking to delete it. */
    const LEAVE_GRACE_MS = 400

    /** Simplified Chinese copy. */
    const zh = {
      nav: '会话管理',
      title: '会话管理',
      intro: '这里列出已归档的对话。可以查看内容、恢复到侧边栏，或者彻底删除。删除会连同磁盘上的对话记录一起清除，无法撤销。',
      menuDelete: '删除对话',
      refresh: '刷新',
      refreshing: '读取中…',
      search: '搜索标题或工作区',
      selectAll: '全选',
      clearAll: '取消全选',
      selected: '已选 {n} 个',
      restoreSelected: '恢复所选',
      deleteSelected: '删除所选',
      count: '共 {n} 个归档对话 · {size} · 最近归档在前',
      empty: '还没有已归档的对话。在侧边栏的对话菜单里选「归档对话」即可归档。',
      emptyFiltered: '没有匹配的归档对话。',
      loadFailed: '读取失败：{msg}',
      columnTitle: '对话',
      columnActions: '操作',
      view: '查看',
      restore: '恢复',
      delete: '删除',
      cleanup: '清理记录',
      unassigned: '未归属工作区',
      missing: '记录缺失',
      missingHint: '这条归档记录对应的日志已经不在磁盘上了，可以「清理记录」把它从归档列表移除。',
      unsupported: '无法读取',
      confirmTitle: '删除这个对话？',
      confirmTitleMany: '删除选中的 {n} 个对话？',
      confirmDesc: '「{title}」将从磁盘上彻底删除，无法恢复。',
      confirmDescMany: '{n} 个对话将从磁盘上彻底删除，无法恢复。',
      confirmCancel: '取消',
      confirmDelete: '删除',
      confirmBusy: '删除中…',
      confirmPartial: '{ok} 个已删除，{failed} 个未删除。',
      failureRunning: '这个对话正在运行，请先停止再删除。',
      failureInUse: '这个对话正在打开，请先切换到其他对话再删除。',
      failureLocked: '对话文件还被占用（可能有进程正在写入），暂时删不掉，请稍后重试。',
      failureGhost: '对话记录已删除，但它仍被进程占用；重启 DeepSeek Harness 后侧边栏那一行会自动消失。',
      failureGeneric: '删除失败：{msg}',
      restoreDone: '已恢复 {n} 个对话。',
      restoreFailed: '恢复失败：{msg}',
      close: '关闭',
      previewTitle: '对话内容',
      previewEmpty: '这个对话还没有可以显示的消息。',
      previewTruncated: '只显示了前 {n} 条事件，更早或更晚的内容没有载入。',
      previewMessages: '{n} 条消息',
      roleUser: '你',
      roleAssistant: '助手',
      roleTool: '工具',
      imageCount: '（{n} 张图片）',
      never: '—',
    }

    /** English copy. */
    const en = {
      nav: 'Sessions',
      title: 'Session manager',
      intro: 'Every archived conversation, in one place. Read one, restore it to the sidebar, or delete it for good. Deleting removes the stored log from disk and cannot be undone.',
      menuDelete: 'Delete conversation',
      refresh: 'Refresh',
      refreshing: 'Reading…',
      search: 'Search title or workspace',
      selectAll: 'Select all',
      clearAll: 'Clear selection',
      selected: '{n} selected',
      restoreSelected: 'Restore selected',
      deleteSelected: 'Delete selected',
      count: '{n} archived conversation(s) · {size} · newest archive first',
      empty: 'Nothing is archived yet. Use 归档对话 in a conversation’s sidebar menu to archive one.',
      emptyFiltered: 'No archived conversation matches that search.',
      loadFailed: 'Could not read the archive: {msg}',
      columnTitle: 'Conversation',
      columnActions: 'Actions',
      view: 'View',
      restore: 'Restore',
      delete: 'Delete',
      cleanup: 'Drop entry',
      unassigned: 'No workspace',
      missing: 'Log missing',
      missingHint: 'The stored log behind this archive entry is gone. “Drop entry” removes the dangling reference.',
      unsupported: 'Unreadable',
      confirmTitle: 'Delete this conversation?',
      confirmTitleMany: 'Delete {n} conversations?',
      confirmDesc: '“{title}” will be permanently removed from disk.',
      confirmDescMany: '{n} conversations will be permanently removed from disk.',
      confirmCancel: 'Cancel',
      confirmDelete: 'Delete',
      confirmBusy: 'Deleting…',
      confirmPartial: '{ok} deleted, {failed} kept.',
      failureRunning: 'This conversation is still running; stop it first.',
      failureInUse: 'This conversation is still open; switch to another one first.',
      failureLocked: 'The stored log is still held open — retry in a moment.',
      failureGhost: 'The log was deleted, but the conversation is still held in memory; restart DeepSeek Harness to clear the row.',
      failureGeneric: 'Delete failed: {msg}',
      restoreDone: 'Restored {n} conversation(s).',
      restoreFailed: 'Restore failed: {msg}',
      close: 'Close',
      previewTitle: 'Conversation',
      previewEmpty: 'This conversation has no messages to show.',
      previewTruncated: 'Only the first {n} events were loaded.',
      previewMessages: '{n} messages',
      roleUser: 'You',
      roleAssistant: 'Assistant',
      roleTool: 'Tool',
      imageCount: '({n} image(s))',
      never: '—',
    }

    /** Stylesheet, injected once per page. Every colour is a theme alias. */
    const CSS = `
.dcm-section{display:flex;flex-direction:column;gap:12px;max-width:820px;color:var(--dsw-alias-label-primary)}
.dcm-heading{margin:0;font-size:18px;font-weight:600}
.dcm-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dcm-toolbar{display:flex;flex-direction:column;gap:8px}
.dcm-toolbar-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;justify-content:flex-end}
.dcm-search{box-sizing:border-box;width:100%;padding:7px 10px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none}
.dcm-search:focus{border-color:var(--dsw-alias-state-business-primary)}
.dcm-btn{font:inherit;font-size:13px;line-height:20px;padding:6px 12px;border-radius:8px;cursor:pointer;white-space:nowrap;color:var(--dsw-alias-label-primary);background:transparent;border:.5px solid var(--dsw-alias-border-l2)}
.dcm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dcm-btn:disabled{opacity:.5;cursor:default}
.dcm-btn-danger{color:var(--dsw-alias-label-error);border-color:var(--dsw-alias-border-l2)}
.dcm-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dcm-head{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:10px;padding:0 10px 6px;font-size:12px;color:var(--dsw-alias-label-tertiary);border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dcm-head-actions{text-align:right;white-space:nowrap}
.dcm-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column}
.dcm-row{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:10px;align-items:start;padding:8px 10px;border-radius:8px;font-size:13px}
.dcm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dcm-check{margin:2px 0 0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}
.dcm-main{display:flex;flex-direction:column;gap:3px;min-width:0}
.dcm-title{min-width:0;text-align:left;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:none;border:0;padding:0;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcm-title:hover{text-decoration:underline}
.dcm-title[data-empty="true"]{color:var(--dsw-alias-label-tertiary)}
.dcm-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.dcm-cell{color:var(--dsw-alias-label-tertiary);font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcm-sep{color:var(--dsw-alias-label-tertiary);font-size:12px;opacity:.55}
.dcm-actions{display:flex;flex-wrap:nowrap;gap:10px;justify-content:flex-end;white-space:nowrap}
.dcm-link{font:inherit;font-size:12px;padding:0;background:none;border:0;cursor:pointer;color:var(--dsw-alias-link);white-space:nowrap}
.dcm-link:hover{text-decoration:underline}
.dcm-link-danger{color:var(--dsw-alias-label-error)}
.dcm-tag{display:inline-block;padding:0 6px;font-size:11px;line-height:16px;border-radius:6px;color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary,transparent)}
.dcm-state{margin:0;font-size:13px;color:var(--dsw-alias-label-tertiary);padding:14px 10px}
.dcm-error{margin:0;font-size:13px;color:var(--dsw-alias-label-error);padding:10px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger,transparent)}
.dcm-foot{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dcm-blocks{display:flex;flex-direction:column;gap:14px;max-height:52vh;overflow:auto;padding-right:4px}
.dcm-block{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2)}
.dcm-block[data-role="user"]{background:var(--dsw-alias-interactive-bg-hover)}
.dcm-role{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.dcm-text{margin:0;font-size:13px;line-height:21px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}
.dcm-block[data-role="tool"] .dcm-text{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dcm-note{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
`

    /**
     * A `useSyncExternalStore`-compatible box.
     *
     * Slot hooks are consumed as `useX(selector)`, which reads `getSnapshot` and
     * subscribes; a plain object is all that contract needs, and rolling it here
     * keeps this plugin free of a runtime package it cannot import.
     * @param initial - the starting value.
     * @returns the store.
     */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set: (next) => {
          if (next === value) return
          value = next
          for (const listener of listeners) listener()
        },
      }
    }

    /**
     * Fill `{name}` placeholders.
     * @param template - the dictionary string.
     * @param vars - replacements; unknown names stay as written.
     * @returns the final text.
     */
    function format(template, vars) {
      return String(template).replace(/\{(\w+)\}/gu, (match, name) => (vars != null && name in vars ? String(vars[name]) : match))
    }

    /**
     * Call one Host route.
     * @param path - suffix below the plugin prefix.
     * @param init - fetch options.
     * @returns the JSON payload.
     * @throws when the Host is unreachable or answered with something that is not JSON.
     */
    async function api(path, init) {
      const response = await fetch(`${PREFIX}${path}`, init)
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (payload === null || typeof payload !== 'object') throw new Error(`HTTP ${response.status}`)
      if (response.status >= 500) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
      return payload
    }

    /**
     * POST a list of ids.
     * @param path - `/api/delete` or `/api/restore`.
     * @param ids - the session ids.
     * @returns the payload.
     */
    function postIds(path, ids) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
    }

    /**
     * Human byte size.
     * @param bytes - the raw size.
     * @returns a short label.
     */
    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return '—'
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      return `${(value / 1024 / 1024).toFixed(1)} MB`
    }

    /**
     * Wall-clock time in the reader's locale.
     * @param value - epoch milliseconds.
     * @param fallback - the text to use when the value is unusable.
     * @returns the formatted time.
     */
    function formatTime(value, fallback) {
      const ms = Number(value)
      if (!Number.isFinite(ms) || ms <= 0) return fallback
      try {
        return new Intl.DateTimeFormat(undefined, {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(ms))
      } catch {
        return new Date(ms).toISOString()
      }
    }

    /**
     * Install the stylesheet once, and only while this page lives.
     * @returns the disposer.
     */
    function installStyle() {
      const tagId = 'dsh-chat-manage/panel.css'
      let tag = document.querySelector(`style[data-plugin-css="${tagId}"]`)
      const created = tag === null
      if (tag === null) {
        tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-chat-manage'
        tag.dataset.pluginCss = tagId
        tag.textContent = CSS
        document.head.appendChild(tag)
      }
      return () => {
        if (created) tag.remove()
      }
    }

    /**
     * The conversation the main view is showing right now.
     *
     * Two independent sources, because either can be absent: the retention record
     * the workspace browser takes when it opens a session (`retainedBy.mainView`),
     * and the browser's own `mainReference`, which also covers a blank draft that
     * has not been retained yet.
     * @param ctx - the plugin context.
     * @returns the session id, or undefined when no conversation is retained.
     */
    function mainSessionId(ctx) {
      try {
        const reference = ctx.get('uiWorkspace')?.mainReference?.sessionId
        if (typeof reference === 'string' && reference.length > 0) return reference
      } catch {
        /* no workspace service: fall through to the retention record */
      }
      try {
        const snapshot = ctx.get('sessions')?.list?.getSnapshot?.()
        const byId = snapshot?.byId
        if (byId === null || typeof byId !== 'object') return undefined
        for (const [id, entry] of Object.entries(byId)) {
          if ((entry?.retainedBy?.mainView ?? 0) > 0) return id
        }
      } catch {
        /* an unreadable store means "cannot tell", and the Host stays the gate */
      }
      return undefined
    }

    /**
     * The menu row: one destructive item, plus closing the menu it lives in.
     * @param props - the slot's session props and this plugin's injected face.
     * @returns the row.
     */
    function DeleteMenuItem({ sessionId, displayTitle, useMenuOpenState, requestDelete, t }) {
      // The parent slot always injects this, but a future build that stops doing
      // so must not take the row down with a TypeError.
      const openState = typeof useMenuOpenState === 'function' ? useMenuOpenState : () => [false, () => {}]
      const [, setMenuOpen] = openState()
      return h(
        UI.MenuItemButton,
        {
          icon: h(UI.IconTrashOutlineRegular, { size: 14 }),
          onSelect: () => {
            setMenuOpen(false)
            requestDelete([sessionId], displayTitle)
          },
        },
        t('menuDelete'),
      )
    }

    /**
     * The overlay: nothing while no request is pending, otherwise one dialog per
     * request. Keyed by the request so a second delete starts with clean state.
     * @param props - the pending-request hook and the callbacks that settle it.
     * @returns the dialog, or null.
     */
    function DeleteConfirmOverlay({ useDeleteRequest, settleDelete, confirmDelete, t }) {
      const request = useDeleteRequest((value) => value)
      if (request === null) return null
      return h(DeleteConfirmForm, { key: request.key, request, settleDelete, confirmDelete, t })
    }

    /**
     * One delete request's dialog. In-flight and error state die with it.
     * @param props - the request, its settlement and the Host call.
     * @returns the dialog.
     */
    function DeleteConfirmForm({ request, settleDelete, confirmDelete, t }) {
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState(null)
      const count = request.ids.length

      const close = () => {
        if (busy) return
        settleDelete()
      }
      const confirm = () => {
        if (busy) return
        setBusy(true)
        setFailure(null)
        Promise.resolve()
          .then(() => confirmDelete(request.ids))
          .then((summary) => {
            setBusy(false)
            if (summary.failed.length === 0) {
              settleDelete()
              return
            }
            setFailure(summary.message)
          })
          .catch((error) => {
            setBusy(false)
            setFailure(format(t('failureGeneric'), { msg: error?.message ?? String(error) }))
          })
      }

      const description = count === 1
        ? format(t('confirmDesc'), { title: request.title.length > 0 ? request.title : request.ids[0] })
        : format(t('confirmDescMany'), { n: count })

      return h(
        UI.Modal,
        {
          open: true,
          onClose: close,
          closeLabel: t('close'),
          title: count === 1 ? t('confirmTitle') : format(t('confirmTitleMany'), { n: count }),
          description,
          footer: h(
            React.Fragment,
            null,
            h(UI.Button, { variant: 'outline', disabled: busy, onClick: close }, t('confirmCancel')),
            h(UI.Button, { variant: 'primary', disabled: busy, onClick: confirm }, busy ? t('confirmBusy') : t('confirmDelete')),
          ),
        },
        failure === null ? null : h('p', { className: 'dcm-error', role: 'alert' }, failure),
      )
    }

    /**
     * The archived-conversation list.
     *
     * Data comes from the Host on mount and after every mutation, keyed by a
     * revision counter the overlay bumps once a delete lands — the settings page
     * has no other way to learn that a dialog it did not open changed the set.
     * @param props - the injected Host calls and the locale reader.
     * @returns the page.
     */
    function SessionManageSection({ t, loadArchived, loadTranscript, restoreSessions, requestDelete, useChatManageRevision }) {
      const revision = useChatManageRevision((value) => value)
      const [state, setState] = React.useState({ phase: 'loading', rows: [], counts: null, error: null })
      const [query, setQuery] = React.useState('')
      const [selected, setSelected] = React.useState(() => new Set())
      const [notice, setNotice] = React.useState(null)
      const [preview, setPreview] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const reload = React.useCallback(() => {
        setState((previous) => ({ ...previous, phase: previous.phase === 'ready' ? 'refreshing' : 'loading', error: null }))
        return Promise.resolve()
          .then(() => loadArchived())
          .then((payload) => {
            if (payload?.ok !== true) {
              setState({ phase: 'error', rows: [], counts: null, error: payload?.error?.message ?? 'error' })
              return
            }
            const rows = Array.isArray(payload.archived) ? payload.archived : []
            setState({ phase: 'ready', rows, counts: payload.counts ?? null, error: null })
            setSelected((previous) => {
              const alive = new Set(rows.map((row) => row.id))
              const next = new Set([...previous].filter((id) => alive.has(id)))
              return next.size === previous.size ? previous : next
            })
          })
          .catch((error) => {
            setState({ phase: 'error', rows: [], counts: null, error: error?.message ?? String(error) })
          })
      }, [loadArchived])

      React.useEffect(() => {
        void reload()
      }, [reload, revision])

      const rows = state.rows
      const needle = query.trim().toLowerCase()
      const visible = needle.length === 0
        ? rows
        : rows.filter((row) => `${row.title ?? ''} ${row.workspaceTitle ?? ''} ${row.cwd ?? ''}`.toLowerCase().includes(needle))

      const toggle = (id) => {
        setSelected((previous) => {
          const next = new Set(previous)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      const selectedIds = [...selected]
      const allSelected = visible.length > 0 && visible.every((row) => selected.has(row.id))

      const restore = (ids) => {
        if (ids.length === 0 || busy) return
        setBusy(true)
        setNotice(null)
        Promise.resolve()
          .then(() => restoreSessions(ids))
          .then((payload) => {
            const restored = (payload?.results ?? []).filter((result) => result.ok === true).length
            const failed = (payload?.results ?? []).filter((result) => result.ok !== true)
            setBusy(false)
            if (restored > 0) setNotice({ level: 'ok', text: format(t('restoreDone'), { n: restored }) })
            if (failed.length > 0) {
              setNotice({ level: 'bad', text: format(t('restoreFailed'), { msg: failed[0]?.message ?? 'error' }) })
            }
            void reload()
          })
          .catch((error) => {
            setBusy(false)
            setNotice({ level: 'bad', text: format(t('restoreFailed'), { msg: error?.message ?? String(error) }) })
          })
      }

      const openPreview = (row) => {
        setPreview({ id: row.id, title: row.title, phase: 'loading', blocks: [], error: null })
        Promise.resolve()
          .then(() => loadTranscript(row.id))
          .then((payload) => {
            if (payload?.ok !== true) {
              setPreview((current) => (current === null ? current : { ...current, phase: 'error', error: payload?.error?.message ?? 'error' }))
              return
            }
            setPreview({
              id: row.id,
              title: payload.title.length > 0 ? payload.title : row.title,
              phase: 'ready',
              blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
              truncated: payload.truncated === true,
              messages: payload.blocks?.length ?? 0,
              error: null,
            })
          })
          .catch((error) => {
            setPreview((current) => (current === null ? current : { ...current, phase: 'error', error: error?.message ?? String(error) }))
          })
      }

      // Two columns, not five: the settings panel is barely wider than 450px, and
      // five fixed tracks plus gaps overflowed it — the title track collapsed to
      // zero and the actions spilled past the edge. The workspace, time and size
      // now sit on a second line under the title, so the row fits any width the
      // shell hands us.
      const head = h(
        'div',
        { className: 'dcm-head' },
        h('span', null, ''),
        h('span', null, t('columnTitle')),
        h('span', { className: 'dcm-head-actions' }, t('columnActions')),
      )

      const body = (() => {
        if (state.phase === 'loading') return h('p', { className: 'dcm-state' }, t('refreshing'))
        if (state.phase === 'error') return h('p', { className: 'dcm-error', role: 'alert' }, format(t('loadFailed'), { msg: state.error ?? 'error' }))
        if (visible.length === 0) return h('p', { className: 'dcm-state' }, needle.length > 0 ? t('emptyFiltered') : t('empty'))
        return h(
          React.Fragment,
          null,
          head,
          h(
            'ul',
            { className: 'dcm-list' },
            visible.map((row) =>
              h(
                'li',
                { className: 'dcm-row', key: row.id },
                h('input', {
                  className: 'dcm-check',
                  type: 'checkbox',
                  checked: selected.has(row.id),
                  onChange: () => toggle(row.id),
                  'aria-label': row.title.length > 0 ? row.title : row.id,
                }),
                h(
                  'div',
                  { className: 'dcm-main' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dcm-title',
                      'data-empty': row.title.length > 0 ? 'false' : 'true',
                      title: row.missing === true ? t('missingHint') : row.title,
                      onClick: () => (row.missing === true ? undefined : openPreview(row)),
                    },
                    row.title.length > 0 ? row.title : row.missing === true ? t('missing') : row.id,
                  ),
                  h(
                    'div',
                    { className: 'dcm-meta' },
                    h('span', { className: 'dcm-cell', title: row.workspaceTitle || row.cwd }, row.workspaceTitle || row.cwd || t('unassigned')),
                    h('span', { className: 'dcm-sep' }, '·'),
                    h('span', { className: 'dcm-cell' }, formatTime(row.updatedAt, t('never'))),
                    h('span', { className: 'dcm-sep' }, '·'),
                    h('span', { className: 'dcm-cell' }, formatBytes(row.sizeBytes)),
                    row.missing === true ? h('span', { className: 'dcm-tag' }, t('missing')) : null,
                    row.unsupported === true ? h('span', { className: 'dcm-tag' }, t('unsupported')) : null,
                  ),
                ),
                h(
                  'span',
                  { className: 'dcm-actions' },
                  row.missing === true
                    ? h(
                        'button',
                        { type: 'button', className: 'dcm-link', disabled: busy, onClick: () => restore([row.id]) },
                        t('cleanup'),
                      )
                    : h(
                        'button',
                        { type: 'button', className: 'dcm-link', onClick: () => openPreview(row) },
                        t('view'),
                      ),
                  h(
                    'button',
                    { type: 'button', className: 'dcm-link', disabled: busy, onClick: () => restore([row.id]) },
                    t('restore'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dcm-link dcm-link-danger',
                      disabled: busy,
                      onClick: () => requestDelete([row.id], row.title),
                    },
                    t('delete'),
                  ),
                ),
              ),
            ),
          ),
        )
      })()

      const previewModal = preview === null
        ? null
        : h(
            UI.Modal,
            {
              key: 'preview',
              open: true,
              onClose: () => setPreview(null),
              closeLabel: t('close'),
              title: preview.title?.length > 0 ? preview.title : t('previewTitle'),
              description: preview.messages === undefined ? undefined : format(t('previewMessages'), { n: preview.messages }),
              footer: h(UI.Button, { variant: 'outline', onClick: () => setPreview(null) }, t('close')),
            },
            preview.phase === 'loading'
              ? h('p', { className: 'dcm-state' }, t('refreshing'))
              : preview.phase === 'error'
                ? h('p', { className: 'dcm-error', role: 'alert' }, format(t('loadFailed'), { msg: preview.error ?? 'error' }))
                : [
                    h(
                      'div',
                      { className: 'dcm-blocks', key: 'blocks' },
                      preview.blocks.length === 0
                        ? h('p', { className: 'dcm-state' }, t('previewEmpty'))
                        : preview.blocks.map((block, index) =>
                            h(
                              'div',
                              { className: 'dcm-block', key: `b-${index}`, 'data-role': block.kind },
                              h(
                                'span',
                                { className: 'dcm-role' },
                                block.kind === 'user'
                                  ? t('roleUser')
                                  : block.kind === 'assistant'
                                    ? t('roleAssistant')
                                    : `${t('roleTool')}${block.name ? ` · ${block.name}` : ''}`,
                              ),
                              h(
                                'p',
                                { className: 'dcm-text' },
                                block.text,
                                block.images > 0 ? format(t('imageCount'), { n: block.images }) : '',
                              ),
                            ),
                          ),
                    ),
                    preview.truncated === true
                      ? h('p', { className: 'dcm-note', key: 'truncated' }, format(t('previewTruncated'), { n: preview.blocks.length }))
                      : null,
                  ],
          )

      return h(
        'div',
        { className: 'dcm-section' },
        h('h2', { className: 'dcm-heading' }, t('title')),
        h('p', { className: 'dcm-intro' }, t('intro')),
        h(
          'div',
          { className: 'dcm-toolbar' },
          h('input', {
            className: 'dcm-search',
            type: 'search',
            placeholder: t('search'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h(
            'div',
            { className: 'dcm-toolbar-row' },
            h(
              'button',
              { type: 'button', className: 'dcm-btn', disabled: state.phase === 'loading', onClick: () => void reload() },
              state.phase === 'refreshing' ? t('refreshing') : t('refresh'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dcm-btn',
                disabled: busy || visible.length === 0,
                onClick: () => setSelected(allSelected ? new Set() : new Set(visible.map((row) => row.id))),
              },
              allSelected ? t('clearAll') : t('selectAll'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dcm-btn',
                disabled: busy || selectedIds.length === 0,
                onClick: () => restore(selectedIds),
              },
              t('restoreSelected'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dcm-btn dcm-btn-danger',
                disabled: busy || selectedIds.length === 0,
                onClick: () => {
                  const single = selectedIds.length === 1 ? rows.find((row) => row.id === selectedIds[0]) : undefined
                  requestDelete(selectedIds, single?.title ?? '')
                },
              },
              t('deleteSelected'),
            ),
          ),
        ),
        selectedIds.length === 0 ? null : h('p', { className: 'dcm-foot' }, format(t('selected'), { n: selectedIds.length })),
        notice === null
          ? null
          : h('p', { className: notice.level === 'bad' ? 'dcm-error' : 'dcm-foot', role: notice.level === 'bad' ? 'alert' : 'status' }, notice.text),
        body,
        state.counts === null
          ? null
          : h('p', { className: 'dcm-foot' }, format(t('count'), { n: state.counts.archived ?? 0, size: formatBytes(state.counts.bytes) })),
        previewModal,
      )
    }

    /** Services this page needs, plus the optional ones it reads defensively. */
    const inject = ['slots', 'locale']

    /**
     * Register both surfaces.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chat-manage: dictionaries')
      ctx.effect(() => installStyle(), 'dsh-chat-manage: stylesheet')

      /** The pending confirmation, shared by the menu row and the settings page. */
      const deleteRequest = createStore(null)

      /** Bumped after any successful delete, so the settings page reloads. */
      const revision = createStore(0)

      /**
       * Open a fresh conversation and give the previous one a moment to be let go.
       *
       * `startSession()` with no workspace picks the current one and replaces the
       * main view, which is what releases the conversation the user was reading.
       * @returns completion once the grace window has passed.
       */
      async function leaveCurrentSession() {
        try {
          ctx.get('uiWorkspace')?.startSession?.()
        } catch {
          /* a deployment without the workspace service simply does not navigate */
        }
        await new Promise((resolve) => setTimeout(resolve, LEAVE_GRACE_MS))
      }

      /**
       * Ask the Host to delete, and report per id.
       * @param ids - the sessions to delete.
       * @returns one result per id.
       */
      async function postDelete(ids) {
        const payload = await postIds('/api/delete', ids)
        return Array.isArray(payload?.results) ? payload.results : []
      }

      /**
       * Delete, moving off the conversation on screen first.
       *
       * Two things have to happen for "delete the conversation I am reading" to
       * work: the client must navigate away (a live conversation is not deletable),
       * and that has to happen *before* the Host is asked. Deleting a conversation
       * that is not on screen needs no navigation at all — which is why the first
       * pass only navigates when the target is the main view.
       *
       * A host that still reports `in-use` gets one retry after a forced
       * navigation, so the user never has to be told "switch conversations first".
       * @param ids - the sessions to delete.
       * @returns a summary the dialog renders.
       */
      async function confirmDelete(ids) {
        const main = mainSessionId(ctx)
        if (main !== undefined && ids.includes(main)) await leaveCurrentSession()

        let results = await postDelete(ids)
        const refused = results.filter((result) => result.code === 'in-use').map((result) => result.id)
        if (refused.length > 0) {
          await leaveCurrentSession()
          const retried = await postDelete(refused)
          const byId = new Map(retried.map((result) => [result.id, result]))
          results = results.map((result) => byId.get(result.id) ?? result)
        }

        const done = results.filter((result) => result.ok === true).length
        const failed = results.filter((result) => result.ok !== true)

        try {
          await ctx.get('sessions')?.refresh?.()
        } catch {
          /* the list also refreshes on the next navigation */
        }
        if (done > 0) revision.set(revision.getSnapshot() + 1)

        if (failed.length === 0) return { deleted: done, failed: [] }
        const first = failed[0]
        const reason = first.code === 'running'
          ? t('failureRunning')
          : first.code === 'in-use'
            ? t('failureInUse')
            : first.code === 'locked'
              ? t('failureLocked')
              : first.code === 'ghost'
                ? t('failureGhost')
                : format(t('failureGeneric'), { msg: first.message ?? first.code ?? 'error' })
        return {
          deleted: done,
          failed,
          message: done > 0
            ? `${format(t('confirmPartial'), { ok: done, failed: failed.length })} ${reason}`
            : reason,
        }
      }

      /**
       * Raise the confirmation dialog for one delete.
       * @param ids - the sessions to delete.
       * @param title - the single-row title, or an empty string for a batch.
       */
      let sequence = 0
      function requestDelete(ids, title) {
        const list = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id.length > 0) : []
        if (list.length === 0) return
        deleteRequest.set({
          key: `request-${++sequence}`,
          ids: list,
          title: typeof title === 'string' ? title : '',
        })
      }

      ctx.slots.inject(MENU_SLOT, function* () {
        yield ctx.slots.register(
          {
            name: MENU_SLOT,
            id: MENU_ID,
            order: MENU_ORDER,
            locale: NS,
            inject: () => ({ requestDelete }),
          },
          DeleteMenuItem,
        )
      })

      ctx.slots.inject(OVERLAY_SLOT, function* () {
        yield ctx.slots.register(
          {
            name: OVERLAY_SLOT,
            id: 'chat-manage-delete-confirm',
            locale: NS,
            inject: () => ({
              hooks: { deleteRequest },
              settleDelete: () => deleteRequest.set(null),
              confirmDelete,
            }),
          },
          DeleteConfirmOverlay,
        )
      })

      ctx.slots.inject(SECTION_SLOT, function* () {
        yield ctx.slots.register(
          {
            name: SECTION_SLOT,
            id: SECTION_ID,
            order: SECTION_ORDER,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({
              hooks: { chatManageRevision: revision },
              loadArchived: () => api('/api/list'),
              loadTranscript: (id) => api(`/api/transcript?id=${encodeURIComponent(id)}`),
              restoreSessions: (ids) => postIds('/api/restore', ids),
              requestDelete,
            }),
          },
          SessionManageSection,
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    exports.NS = NS
    exports.SECTION_ID = SECTION_ID
    exports.MENU_SLOT = MENU_SLOT
    exports.SECTION_SLOT = SECTION_SLOT
    exports.OVERLAY_SLOT = OVERLAY_SLOT
    return module.exports
  },
})
