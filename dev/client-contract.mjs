/**
 * Contract check for the browser half.
 *
 * `client.js` is not an ES module: the shell evaluates it with a global
 * `__ModuleLoader__` and hands its factory a `require` that resolves platform
 * modules. This script reproduces exactly that — a stub loader, a stub
 * `require`, a stub `document`, and a fake slot registry — so the three
 * registrations can be asserted without a browser, a Harness runtime, or a
 * rebuilt bundle. It catches the failures that are otherwise only visible as a
 * silently missing menu row: a wrong slot name, a missing `id`, or an injected
 * face that no longer carries what the component destructures.
 *
 * Run with `node dev/client-contract.mjs`.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'client.js'), 'utf8')

/** Minimal DOM so the stylesheet helper can run. */
function fakeDocument() {
  const head = { appendChild() {} }
  return {
    head,
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  }
}

/** Minimal React: enough for `createElement` and the hooks `apply` never calls. */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useId: () => 'id',
  useRef: (value) => ({ current: value }),
}

/** A primitives stub: every component resolves to its own name, so typos surface. */
const ui = new Proxy({}, { get: (_target, name) => name })

/** Platform modules the client half may require. */
const modules = {
  react: React,
  'react/jsx-runtime': { jsx: React.createElement, jsxs: React.createElement, Fragment: React.Fragment },
  '@deepseek-ai/dsh-client-ui-primitives': ui,
}

globalThis.document = fakeDocument()

/** Registrations the fake slot registry collected. */
const registrations = []

/** A context whose `slots.inject` drives generator factories like the real one. */
function fakeContext(services = {}) {
  return {
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
    },
    effect: (factory) => {
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get: (key) => services[key],
    slots: {
      inject: (name, factory) => {
        const produced = factory()
        if (produced !== null && typeof produced === 'object' && typeof produced[Symbol.iterator] === 'function') {
          for (const _entry of produced) void _entry
          return () => {}
        }
        return typeof produced === 'function' ? produced : () => {}
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
}

let failed = 0
const check = async (name, body) => {
  try {
    await body()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}

/** Evaluate `client.js` the way the shell does and return its exports. */
function loadClient() {
  const loaded = []
  const loader = {
    load: (entry) => {
      loaded.push(entry)
    },
  }
  // The file is a plain script from the module system's point of view: it calls
  // the global loader and defines no exports of its own.
  new Function('_ModuleLoader__', source)(loader)
  assert.equal(loaded.length, 1, 'client.js calls the module loader exactly once')
  const [entry] = loaded
  const clientModule = entry.factory((id) => {
    const resolved = modules[id]
    if (resolved === undefined) throw new Error(`unexpected platform module "${id}"`)
    return resolved
  })
  return { entry, clientModule }
}

await check('client.js registers itself under the package name', async () => {
  const { entry, clientModule } = loadClient()
  assert.equal(entry.id, 'dsh-chat-manage')
  assert.equal(typeof clientModule.apply, 'function')
  assert.deepEqual(clientModule.inject, ['slots', 'locale'])
})

await check('apply registers the menu row, the dialog and the settings page', async () => {
  registrations.length = 0
  const { clientModule } = loadClient()
  clientModule.apply(fakeContext())

  const byName = new Map(registrations.map((entry) => [entry.options.name, entry]))
  assert.deepEqual([...byName.keys()].sort(), [
    'settings.section',
    'shell.overlay',
    'sidebar.workspaces.session.menu.item',
  ])
  assert.equal(byName.get('sidebar.workspaces.session.menu.item').options.id, 'chat-manage-delete')
  assert.equal(byName.get('sidebar.workspaces.session.menu.item').options.locale, 'chatManage')
  assert.equal(byName.get('settings.section').options.id, 'session-manage')
  assert.equal(byName.get('settings.section').options.order, 5, 'sorts between 通用 (0) and 模型 (10)')
  assert.equal(typeof byName.get('settings.section').options.label, 'function')
  assert.equal(byName.get('shell.overlay').options.id, 'chat-manage-delete-confirm')
  for (const entry of registrations) assert.equal(typeof entry.component, 'function', `${entry.options.name} has a component`)
})

await check('the menu face raises a request the overlay can read', async () => {
  registrations.length = 0
  const { clientModule } = loadClient()
  clientModule.apply(fakeContext())

  const menu = registrations.find((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')
  const overlay = registrations.find((entry) => entry.options.name === 'shell.overlay')
  const menuFace = menu.options.inject()
  const overlayFace = overlay.options.inject()

  assert.equal(typeof menuFace.requestDelete, 'function')
  assert.equal(overlayFace.hooks.deleteRequest.getSnapshot(), null)
  menuFace.requestDelete(['session-a'], '标题')
  const pending = overlayFace.hooks.deleteRequest.getSnapshot()
  assert.deepEqual(pending.ids, ['session-a'])
  assert.equal(pending.title, '标题')
  overlayFace.settleDelete()
  assert.equal(overlayFace.hooks.deleteRequest.getSnapshot(), null)
})

await check('the settings face exposes every call the page destructures', async () => {
  registrations.length = 0
  const { clientModule } = loadClient()
  clientModule.apply(fakeContext())

  const section = registrations.find((entry) => entry.options.name === 'settings.section')
  const face = section.options.inject()
  for (const key of ['loadArchived', 'loadTranscript', 'restoreSessions', 'requestDelete']) {
    assert.equal(typeof face[key], 'function', `injected ${key}`)
  }
  const hooks = Object.keys(face.hooks)
  assert.deepEqual(hooks, ['chatManageRevision'])
  const source = face.hooks.chatManageRevision
  assert.equal(typeof source.getSnapshot, 'function')
  assert.equal(typeof source.subscribe, 'function')
})

await check('a batch request keeps one entry per id and ignores empty input', async () => {
  registrations.length = 0
  const { clientModule } = loadClient()
  clientModule.apply(fakeContext())

  const menu = registrations.find((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')
  const overlay = registrations.find((entry) => entry.options.name === 'shell.overlay')
  const menuFace = menu.options.inject()
  const overlayFace = overlay.options.inject()

  menuFace.requestDelete([], '')
  assert.equal(overlayFace.hooks.deleteRequest.getSnapshot(), null, 'an empty request opens nothing')

  menuFace.requestDelete(['a', '', 'b'], '')
  assert.deepEqual(overlayFace.hooks.deleteRequest.getSnapshot().ids, ['a', 'b'])
})

if (failed > 0) {
  console.error(`\n${failed} contract check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nclient contract verified')
}
