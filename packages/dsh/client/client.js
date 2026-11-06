// dsh-session-recap's browser half: a "Session recap" tab in dsh web's right
// sidebar, at parity with the Claude Code pane: this session's recap (Intent
// and Where to resume cards, Recap and Map views, section tabs) and the
// project's sessions from every agent.
//
// Plain JavaScript in the host's module-loader format (no build step); React
// comes from the host, colours from dsh's theme tokens. The panel talks to the
// plugin's server half through its own command, `/recap --panel <json>`.
window.__ModuleLoader__.load({
  id: 'dsh-session-recap',
  factory: require => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var ID = 'dsh-session-recap'
    var KIND = 'session-recap'
    var AGENTS = { claude: 'Claude Code', codex: 'Codex', dsh: 'dsh', opencode: 'OpenCode' }

    // ---------------------------------------------------------------- channel

    function service(ctx, name) {
      try {
        var found = ctx.get(name)
        if (found !== undefined) return found
      } catch (err) {
        // Not provided by this host.
      }
      return undefined
    }

    // Runs one command line in a session; resolves { ok, text } or { ok: false, error }.
    function run(ctx, sessionId, line, timeoutMs) {
      var commands = service(ctx, 'remote.commands')
      if (!commands || typeof commands.execute !== 'function') {
        return Promise.resolve({ ok: false, error: 'this dsh has no command channel for plugins' })
      }
      var controller = new AbortController()
      var timer = setTimeout(function () {
        controller.abort()
      }, timeoutMs || 600000)
      return Promise.resolve(commands.execute(sessionId, line, [], controller.signal))
        .then(function (envelope) {
          if (envelope && envelope.ok === false) {
            return {
              ok: false,
              error: String((envelope.error && envelope.error.message) || envelope.error || 'rejected'),
            }
          }
          var execution = envelope && 'value' in envelope ? envelope.value : envelope
          var result = (execution && execution.result) || execution
          if (!result) return { ok: false, error: 'no answer' }
          if (result.kind === 'error') return { ok: false, error: String(result.text) }
          return { ok: true, text: String(result.text || '') }
        })
        .catch(function (err) {
          return { ok: false, error: controller.signal.aborted ? 'timed out' : String((err && err.message) || err) }
        })
        .finally(function () {
          clearTimeout(timer)
        })
    }

    // One panel read. The plugin's route (POST /api/session-recap/panel, behind
    // dsh's browser authentication) writes nothing into the chat; a host
    // without it is asked through the command. Resolves the value, rejects
    // with the error.
    var PANEL_URL = '/api/session-recap/panel'
    var routeMissing = false

    function unwrap(answer) {
      if (!answer || typeof answer !== 'object') throw new Error('the plugin gave no answer')
      if (!answer.ok) throw new Error(answer.error)
      return answer.value
    }

    function viaCommand(ctx, sessionId, request) {
      return run(ctx, sessionId, '/recap --panel ' + JSON.stringify(request), 60000).then(function (r) {
        if (!r.ok) throw new Error(r.error)
        try {
          return JSON.parse(r.text)
        } catch (err) {
          throw new Error('the plugin answered in an older format; update dsh-session-recap')
        }
      })
    }

    function ask(ctx, sessionId, request) {
      if (routeMissing) return viaCommand(ctx, sessionId, request).then(unwrap)
      return fetch(PANEL_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      }).then(function (res) {
        if (res.status === 404 || res.status === 405) {
          routeMissing = true
          return viaCommand(ctx, sessionId, request).then(unwrap)
        }
        if (!res.ok) throw new Error('dsh refused the request (' + res.status + ')')
        return res.json().then(unwrap)
      })
    }

    // Writes a recap with the model of the session the panel sits in: `/recap`
    // runs there, so the recap also lands in the chat, as when typed.
    function writeRecap(ctx, sessionId, target, isCurrent, refresh) {
      var line = '/recap' + (refresh ? ' --refresh' : '') + (isCurrent ? '' : ' ' + target.id)
      return run(ctx, sessionId, line, 600000).then(function (r) {
        if (!r.ok) throw new Error(String(r.error).replace(/^\[recap\]\s*/, ''))
        return ask(ctx, sessionId, { op: 'get', agent: target.agent, id: target.id })
      })
    }

    // ---------------------------------------------------------------- styles

    var CSS = [
      '.sr{--sr-fg:var(--dsw-alias-label-primary,#0f1115);--sr-fg2:var(--dsw-alias-label-secondary,#61666b);--sr-fg3:var(--dsw-alias-label-tertiary,#81858c);',
      '--sr-line:var(--dsw-alias-border-l2,#0000001a);--sr-soft:var(--dsw-alias-border-l1,#0000000a);--sr-hover:var(--dsw-alias-interactive-bg-hover,#0000000a);',
      '--sr-accent:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4176e6);--sr-ok:var(--dsw-alias-state-success-primary,#22c55e);',
      '--sr-warn:var(--dsw-alias-state-warn-primary,#f59e0b);--sr-r:var(--dsw-radius-md,8px);',
      'height:100%;overflow:auto;box-sizing:border-box;padding:10px 14px 24px;color:var(--sr-fg);font-size:13px;line-height:1.55;font-family:var(--dsw-font-family,inherit)}',
      '.sr *{box-sizing:border-box}',
      '.sr-top{display:flex;align-items:center;gap:6px;margin-bottom:10px}',
      '.sr-seg{display:inline-flex;border:1px solid var(--sr-line);border-radius:999px;padding:2px;gap:2px}',
      '.sr-seg button{border:0;background:transparent;color:var(--sr-fg2);font:inherit;font-size:12px;padding:3px 10px;border-radius:999px;cursor:pointer}',
      '.sr-seg button[aria-pressed=true]{background:var(--sr-hover);color:var(--sr-fg);font-weight:600}',
      '.sr-sp{flex:1}',
      '.sr-btn{border:1px solid var(--sr-line);background:transparent;color:var(--sr-fg);font:inherit;font-size:12px;padding:4px 10px;border-radius:var(--sr-r);cursor:pointer}',
      '.sr-btn:hover{background:var(--sr-hover)}.sr-btn:disabled{opacity:.5;cursor:default}',
      '.sr-btn.pri{background:var(--sr-accent);border-color:var(--sr-accent);color:#fff}',
      '.sr-link{border:0;background:none;color:var(--sr-fg2);font:inherit;font-size:12px;cursor:pointer;padding:2px 0}',
      '.sr-link:hover{color:var(--sr-fg)}',
      '.sr-h{font-size:15px;font-weight:600;margin:2px 0 2px;word-break:break-word}',
      '.sr-meta{color:var(--sr-fg3);font-size:12px;margin-bottom:10px}',
      '.sr-card{border:1px solid var(--sr-line);border-radius:var(--sr-r);padding:8px 10px;margin:8px 0}',
      '.sr-card.resume{border-left:3px solid var(--sr-accent)}',
      '.sr-label{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--sr-fg3);margin-bottom:2px}',
      '.sr-tabs{display:flex;gap:12px;border-bottom:1px solid var(--sr-line);margin:12px 0 8px;overflow-x:auto}',
      '.sr-tabs button{border:0;background:none;font:inherit;font-size:12px;color:var(--sr-fg2);padding:4px 0 6px;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}',
      '.sr-tabs button[aria-selected=true]{color:var(--sr-fg);border-bottom-color:var(--sr-fg);font-weight:600}',
      '.sr-md p{margin:0 0 8px}.sr-md ul,.sr-md ol{margin:0 0 8px;padding-left:18px}.sr-md li{margin:2px 0}',
      '.sr-md h2,.sr-md h3,.sr-md h4{font-size:13px;font-weight:600;margin:12px 0 4px}',
      '.sr-md code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;background:var(--sr-soft);border-radius:4px;padding:0 3px}',
      '.sr-md pre{background:var(--sr-soft);border-radius:var(--sr-r);padding:8px;overflow:auto;font-size:12px;margin:0 0 8px}',
      '.sr-md pre code{background:none;padding:0}.sr-md a{color:var(--dsw-alias-link,var(--sr-accent))}',
      '.sr-md>:last-child{margin-bottom:0}',
      '.sr-muted{color:var(--sr-fg2)}.sr-err{color:#d93025;white-space:pre-wrap;margin:8px 0}',
      '.sr-chips{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 8px}',
      '.sr-chip{border:1px solid var(--sr-line);background:transparent;color:var(--sr-fg2);font:inherit;font-size:11px;padding:1px 8px;border-radius:999px;cursor:pointer}',
      '.sr-chip[aria-pressed=true]{color:var(--sr-fg);border-color:var(--sr-fg);font-weight:600}',
      '.sr-row{display:block;width:100%;text-align:left;border:0;background:none;color:inherit;font:inherit;padding:7px 8px;margin:0 -8px;border-radius:var(--sr-r);cursor:pointer}',
      '.sr-row:hover{background:var(--sr-hover)}',
      '.sr-row-t{display:flex;align-items:center;gap:6px}.sr-row-t b{font-weight:500;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sr-row-i{color:var(--sr-fg2);font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:1px}',
      '.sr-badge{font-size:10px;color:var(--sr-fg3);border:1px solid var(--sr-line);border-radius:4px;padding:0 4px;white-space:nowrap}',
      '.sr-when{font-size:11px;color:var(--sr-fg3);white-space:nowrap}',
      '.sr-dot{width:7px;height:7px;border-radius:50%;flex:none;border:1px solid var(--sr-line)}',
      '.sr-dot.fresh{background:var(--sr-ok);border-color:var(--sr-ok)}.sr-dot.stale{background:var(--sr-warn);border-color:var(--sr-warn)}',
      '.sr-bar{height:3px;border-radius:2px;background:var(--sr-soft);overflow:hidden;margin:10px 0 6px}',
      '.sr-bar i{display:block;height:100%;width:35%;background:var(--sr-accent);border-radius:2px;animation:sr-slide 1.3s ease-in-out infinite}',
      '@keyframes sr-slide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}',
      '.sr-phases{position:relative;margin:6px 0 4px 4px;padding-left:14px;border-left:2px solid var(--sr-line)}',
      '.sr-phase{position:relative;margin:0 0 10px}',
      '.sr-phase:before{content:"";position:absolute;left:-20px;top:5px;width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-bg-base,#fff);border:2px solid var(--sr-accent)}',
      '.sr-phase.pivot:before{background:var(--sr-warn);border-color:var(--sr-warn)}',
      '.sr-phase b{font-weight:600}.sr-phase small{color:var(--sr-fg3);margin-left:6px}',
      '.sr-dec{border:1px solid var(--sr-line);border-radius:var(--sr-r);padding:6px 8px;margin:6px 0}',
      '.sr-dec-t{display:flex;gap:6px;align-items:baseline}.sr-dec-t b{flex:1;font-weight:500}',
      '.sr-st{font-size:10px;border-radius:4px;padding:0 5px;white-space:nowrap}',
      '.sr-st.done{color:var(--sr-ok);border:1px solid var(--sr-ok)}.sr-st.open{color:var(--sr-accent);border:1px solid var(--sr-accent)}.sr-st.paused{color:var(--sr-warn);border:1px solid var(--sr-warn)}',
      '.sr-rej{color:var(--sr-fg3);font-size:12px;text-decoration:line-through}',
      '.sr-why{color:var(--sr-fg2);font-size:12px}',
      '.sr-sec{margin-top:12px}',
      '.sr-pick{width:100%;font:inherit;font-size:12px;color:var(--sr-fg2);background:transparent;border:1px solid var(--sr-line);border-radius:var(--sr-r);padding:4px 6px;margin-bottom:8px;text-overflow:ellipsis}',
    ].join('')

    function useStyles() {
      React.useEffect(function () {
        if (document.getElementById('session-recap-css')) return
        var el = document.createElement('style')
        el.id = 'session-recap-css'
        el.textContent = CSS
        document.head.appendChild(el)
      }, [])
    }

    // ---------------------------------------------------------------- Markdown

    // A small renderer for what recaps contain: headings, paragraphs, lists,
    // code, bold, italics and links. It builds React elements, so nothing in a
    // recap is ever parsed as HTML.
    function inline(text, key) {
      var out = []
      var re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g
      var last = 0
      var m
      var i = 0
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push(text.slice(last, m.index))
        var k = key + '-' + i++
        if (m[1]) out.push(h('code', { key: k }, m[1].slice(1, -1)))
        else if (m[2]) out.push(h('strong', { key: k }, inline(m[2].slice(2, -2), k)))
        else if (m[3]) out.push(h('em', { key: k }, m[3].slice(1, -1)))
        else if (m[4]) {
          var label = m[4].slice(1, m[4].indexOf(']('))
          out.push(h('a', { key: k, href: m[5], target: '_blank', rel: 'noopener noreferrer' }, label))
        }
        last = re.lastIndex
      }
      if (last < text.length) out.push(text.slice(last))
      return out
    }

    function blocks(markdown) {
      var lines = String(markdown || '').split('\n')
      var out = []
      var para = []
      var list = null
      var n = 0
      function flush() {
        if (para.length) out.push(h('p', { key: 'p' + n++ }, inline(para.join(' '), 'p' + n)))
        para = []
        if (list) out.push(h(list.ordered ? 'ol' : 'ul', { key: 'l' + n++ }, list.items))
        list = null
      }
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i]
        var fence = line.match(/^\s*```/)
        if (fence) {
          flush()
          var code = []
          for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i])
          out.push(h('pre', { key: 'c' + n++ }, h('code', null, code.join('\n'))))
          continue
        }
        var head = line.match(/^(#{1,6})\s+(.*)$/)
        if (head) {
          flush()
          var level = Math.min(4, Math.max(2, head[1].length))
          out.push(h('h' + level, { key: 'h' + n++ }, inline(head[2], 'h' + n)))
          continue
        }
        var item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
        if (item) {
          if (para.length) {
            var keep = list
            list = null
            flush()
            list = keep
          }
          var ordered = /\d/.test(item[2])
          if (!list || list.ordered !== ordered) {
            if (list) flush()
            list = { ordered: ordered, items: [] }
          }
          var nested = item[1].length >= 2
          list.items.push(
            h('li', { key: 'i' + n++, style: nested ? { marginLeft: 14 } : undefined }, inline(item[3], 'i' + n)),
          )
          continue
        }
        if (line.trim() === '') {
          flush()
          continue
        }
        if (list && /^\s{2,}\S/.test(line)) {
          // A wrapped list item.
          var last = list.items.pop()
          list.items.push(
            h(
              'li',
              { key: last.key, style: last.props.style },
              last.props.children,
              ' ',
              inline(line.trim(), 'w' + n++),
            ),
          )
          continue
        }
        if (list) flush()
        para.push(line.trim())
      }
      flush()
      return out
    }

    function Markdown(props) {
      return h('div', { className: 'sr-md' }, blocks(props.text))
    }

    // ---------------------------------------------------------------- pieces

    function ago(ms) {
      if (!ms) return ''
      var s = (Date.now() - ms) / 1000
      if (s < 60) return 'just now'
      if (s < 3600) return Math.floor(s / 60) + 'm ago'
      if (s < 86400) return Math.floor(s / 3600) + 'h ago'
      if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago'
      return new Date(ms).toLocaleDateString()
    }

    function short(cwd) {
      return String(cwd).replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, '~')
    }

    function Seg(props) {
      return h(
        'div',
        { className: 'sr-seg', role: 'group' },
        props.options.map(function (o) {
          return h(
            'button',
            {
              key: o.value,
              type: 'button',
              'aria-pressed': props.value === o.value,
              onClick: function () {
                props.onChange(o.value)
              },
            },
            o.label,
          )
        }),
      )
    }

    function Progress(props) {
      return h('div', null, h('div', { className: 'sr-bar' }, h('i')), h('div', { className: 'sr-muted' }, props.label))
    }

    var TABS = [
      { key: 'all', label: 'Recap' },
      { key: 'ideas', label: 'Decisions' },
      { key: 'changed', label: 'Changes' },
      { key: 'open', label: 'Open threads' },
    ]

    function MapView(props) {
      var map = props.map
      if (!map) return h('p', { className: 'sr-muted' }, 'This recap has no map. Refresh it to draw one.')
      var parts = []
      if (map.phases.length) {
        parts.push(
          h(
            'div',
            { key: 'ph', className: 'sr-sec' },
            h('div', { className: 'sr-label' }, 'Timeline'),
            h(
              'div',
              { className: 'sr-phases' },
              map.phases.map(function (p, i) {
                var when = [p.from, p.to].filter(Boolean).join(' – ')
                return h(
                  'div',
                  { key: i, className: 'sr-phase' + (p.pivot ? ' pivot' : '') },
                  h('b', null, p.title),
                  when && h('small', null, when),
                  p.pivot && h('small', null, 'pivot'),
                  p.summary && h('div', { className: 'sr-why' }, p.summary),
                )
              }),
            ),
          ),
        )
      }
      if (map.decisions.length) {
        parts.push(
          h(
            'div',
            { key: 'de', className: 'sr-sec' },
            h('div', { className: 'sr-label' }, 'Decisions'),
            map.decisions.map(function (d, i) {
              return h(
                'div',
                { key: i, className: 'sr-dec' },
                h(
                  'div',
                  { className: 'sr-dec-t' },
                  h('b', null, d.chosen),
                  h('span', { className: 'sr-st ' + d.status }, d.status),
                ),
                d.rejected.length > 0 && h('div', { className: 'sr-rej' }, d.rejected.join(' · ')),
                d.why && h('div', { className: 'sr-why' }, d.why),
              )
            }),
          ),
        )
      }
      ;[
        ['shipped', 'Shipped'],
        ['open', 'Open'],
        ['rejected', 'Set aside'],
      ].forEach(function (pair) {
        var items = map[pair[0]]
        if (!items || !items.length) return
        parts.push(
          h(
            'div',
            { key: pair[0], className: 'sr-sec sr-md' },
            h('div', { className: 'sr-label' }, pair[1]),
            h(
              'ul',
              null,
              items.map(function (t, i) {
                return h('li', { key: i }, inline(t, pair[0] + i))
              }),
            ),
          ),
        )
      })
      return h('div', null, parts)
    }

    // The full recap less the sections already shown as cards above it.
    function withoutCards(markdown, sections) {
      if (!sections.intent && !sections.resume) return markdown
      return markdown
        .split(/^(?=##\s)/m)
        .filter(function (part) {
          var heading = (part.match(/^##\s+(.*)/) || [])[1]
          if (heading === undefined) return part.trim() !== '' && !/^#\s/.test(part.trim())
          var body = part.slice(part.indexOf('\n') + 1).trim()
          return body !== (sections.intent || '').trim() && body !== (sections.resume || '').trim()
        })
        .join('')
    }

    // One session's recap: cards, Recap/Map toggle, section tabs.
    function RecapView(props) {
      var data = props.data
      var session = data.session
      var recap = data.recap
      var mode = React.useState('recap')
      var tab = React.useState('all')
      var copied = React.useState(false)
      var head = h(
        'div',
        null,
        h('div', { className: 'sr-h' }, session.title || session.id),
        h(
          'div',
          { className: 'sr-meta' },
          [
            AGENTS[session.agent] || session.agent,
            recap && recap.model,
            recap && 'written ' + ago(recap.at),
            recap && session.recap && !session.recap.fresh && 'session has moved on',
          ]
            .filter(Boolean)
            .join(' · '),
        ),
      )
      var actions = h(
        'div',
        { className: 'sr-top' },
        h(
          'button',
          {
            type: 'button',
            className: recap ? 'sr-btn' : 'sr-btn pri',
            disabled: props.busy || !props.canWrite,
            onClick: props.onWrite,
          },
          recap ? (session.recap && session.recap.fresh ? 'Rewrite' : 'Update recap') : 'Write recap',
        ),
        recap &&
          h(
            'button',
            {
              type: 'button',
              className: 'sr-btn',
              onClick: function () {
                navigator.clipboard.writeText(recap.markdown).then(function () {
                  copied[1](true)
                  setTimeout(function () {
                    copied[1](false)
                  }, 1500)
                })
              },
            },
            copied[0] ? 'Copied' : 'Copy',
          ),
        h('span', { className: 'sr-sp' }),
        recap &&
          h(Seg, {
            value: mode[0],
            onChange: mode[1],
            options: [
              { value: 'recap', label: 'Recap' },
              { value: 'map', label: 'Map' },
            ],
          }),
      )
      var body
      if (props.busy) body = h(Progress, { label: props.busy })
      else if (!recap)
        body = h(
          'p',
          { className: 'sr-muted' },
          props.canWrite
            ? 'No recap yet. Write one: intent, key decisions, what changed, open threads and where to resume.'
            : 'No recap yet, and this session has no model to write one. Set provider and model in the plugin config.',
        )
      else if (mode[0] === 'map') body = h(MapView, { map: recap.map })
      else {
        var s = recap.sections || {}
        var shown = tab[0] === 'all' ? withoutCards(recap.markdown, s) : s[tab[0]] || '_Nothing in this section._'
        body = h(
          'div',
          null,
          s.intent &&
            h(
              'div',
              { className: 'sr-card' },
              h('div', { className: 'sr-label' }, 'Intent'),
              h(Markdown, { text: s.intent }),
            ),
          s.resume &&
            h(
              'div',
              { className: 'sr-card resume' },
              h('div', { className: 'sr-label' }, 'Where to resume'),
              h(Markdown, { text: s.resume }),
            ),
          h(
            'div',
            { className: 'sr-tabs', role: 'tablist' },
            TABS.map(function (t) {
              return h(
                'button',
                {
                  key: t.key,
                  type: 'button',
                  role: 'tab',
                  'aria-selected': tab[0] === t.key,
                  onClick: function () {
                    tab[1](t.key)
                  },
                },
                t.label,
              )
            }),
          ),
          h(Markdown, { text: shown }),
        )
      }
      return h('div', null, head, actions, props.error && h('div', { className: 'sr-err' }, props.error), body)
    }

    function SessionList(props) {
      var filter = React.useState('all')
      var rows = props.sessions || []
      var counts = {}
      rows.forEach(function (r) {
        counts[r.agent] = (counts[r.agent] || 0) + 1
      })
      var agents = Object.keys(counts)
      var shown = rows.filter(function (r) {
        return filter[0] === 'all' || r.agent === filter[0]
      })
      return h(
        'div',
        null,
        h(
          'select',
          {
            className: 'sr-pick',
            value: props.cwd || '',
            title: props.cwd,
            onFocus: props.onPickerOpen,
            onChange: function (e) {
              props.onPick(e.target.value)
            },
          },
          (props.projects || [{ cwd: props.cwd || '', sessions: rows.length }])
            .concat(
              props.projects &&
                props.cwd &&
                !props.projects.some(function (p) {
                  return p.cwd === props.cwd
                })
                ? [{ cwd: props.cwd, sessions: rows.length }]
                : [],
            )
            .map(function (p) {
              return h(
                'option',
                { key: p.cwd, value: p.cwd },
                (p.cwd ? short(p.cwd) : 'No project') + ' · ' + p.sessions,
              )
            }),
        ),
        agents.length > 1 &&
          h(
            'div',
            { className: 'sr-chips' },
            [{ key: 'all', label: 'All ' + rows.length }]
              .concat(
                agents.map(function (a) {
                  return { key: a, label: (AGENTS[a] || a) + ' ' + counts[a] }
                }),
              )
              .map(function (c) {
                return h(
                  'button',
                  {
                    key: c.key,
                    type: 'button',
                    className: 'sr-chip',
                    'aria-pressed': filter[0] === c.key,
                    onClick: function () {
                      filter[1](c.key)
                    },
                  },
                  c.label,
                )
              }),
          ),
        shown.length === 0 && h('p', { className: 'sr-muted' }, 'No sessions here yet.'),
        shown.map(function (r) {
          return h(
            'button',
            {
              key: r.agent + r.id,
              type: 'button',
              className: 'sr-row',
              onClick: function () {
                props.onOpen(r)
              },
            },
            h(
              'div',
              { className: 'sr-row-t' },
              h('span', {
                className: 'sr-dot' + (r.recap ? (r.recap.fresh ? ' fresh' : ' stale') : ''),
                title: r.recap ? (r.recap.fresh ? 'recap is current' : 'recap is behind the session') : 'no recap',
              }),
              h('b', null, r.title || r.id),
              h('span', { className: 'sr-badge' }, AGENTS[r.agent] || r.agent),
              h('span', { className: 'sr-when' }, ago(r.mtimeMs)),
            ),
            r.recap && r.recap.intent && h('div', { className: 'sr-row-i' }, inline(r.recap.intent, 'n' + r.id)),
          )
        }),
      )
    }

    // ---------------------------------------------------------------- the tab

    function makeBody(ctx) {
      return function RecapBody(props) {
        useStyles()
        var sessionId = props.sessionId
        var st = React.useState({ phase: 'loading' })
        var state = st[0]
        var setState = st[1]
        // What is open: 'current', 'list', or a session { agent, id }.
        var openSt = React.useState('current')
        var open = openSt[0]
        var setOpen = openSt[1]
        var other = React.useState(null)
        var busySt = React.useState(null)
        var errSt = React.useState(null)
        var alive = React.useRef(true)
        React.useEffect(function () {
          alive.current = true
          return function () {
            alive.current = false
          }
        }, [])

        // The project the Sessions list shows, when the person picked another one.
        var listCwd = React.useState(null)
        var listRows = React.useState(null)
        var projects = React.useState(null)

        var load = React.useCallback(
          function (cwd) {
            if (!sessionId) return
            ask(ctx, sessionId, { op: 'home', sessionId: sessionId }).then(
              function (home) {
                if (alive.current) setState({ phase: 'ready', home: home })
              },
              function (err) {
                if (alive.current) setState({ phase: 'failed', error: err.message })
              },
            )
          },
          [sessionId],
        )
        React.useEffect(
          function () {
            load()
          },
          [load],
        )
        React.useEffect(
          function () {
            if (!listCwd[0]) return
            listRows[1](null)
            ask(ctx, sessionId, { op: 'sessions', cwd: listCwd[0] }).then(
              function (r) {
                if (alive.current) listRows[1](r.sessions)
              },
              function (err) {
                if (alive.current) errSt[1](err.message)
              },
            )
          },
          [listCwd[0], state.home],
        )
        function loadProjects() {
          if (projects[0]) return
          ask(ctx, sessionId, { op: 'projects' }).then(function (r) {
            if (alive.current) projects[1](r.projects)
          })
        }

        function write(target, refresh) {
          busySt[1]('Writing the recap… long sessions take a minute or two.')
          errSt[1](null)
          writeRecap(ctx, sessionId, target, open === 'current', refresh).then(
            function (data) {
              if (!alive.current) return
              busySt[1](null)
              if (open === 'current') {
                setState(function (s) {
                  return { phase: 'ready', home: Object.assign({}, s.home, { current: data }) }
                })
              } else other[1](data)
              load()
            },
            function (err) {
              if (!alive.current) return
              busySt[1](null)
              errSt[1](err.message)
            },
          )
        }

        function openSession(row) {
          var home = state.home
          if (home && home.current && home.current.session.agent === row.agent && home.current.session.id === row.id) {
            setOpen('current')
            return
          }
          setOpen({ agent: row.agent, id: row.id })
          other[1](null)
          errSt[1](null)
          ask(ctx, sessionId, { op: 'get', agent: row.agent, id: row.id }).then(
            function (data) {
              if (alive.current) other[1](data)
            },
            function (err) {
              if (alive.current) errSt[1](err.message)
            },
          )
        }

        if (!sessionId)
          return h('div', { className: 'sr' }, h('p', { className: 'sr-muted' }, 'Open a session to see its recap.'))
        if (state.phase === 'loading') return h('div', { className: 'sr' }, h(Progress, { label: 'Reading sessions…' }))
        if (state.phase === 'failed')
          return h(
            'div',
            { className: 'sr' },
            h('div', { className: 'sr-err' }, state.error),
            h(
              'button',
              {
                type: 'button',
                className: 'sr-btn',
                onClick: function () {
                  load()
                },
              },
              'Try again',
            ),
          )

        var home = state.home
        var top = h(
          'div',
          { className: 'sr-top' },
          typeof open === 'object'
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'sr-link',
                  onClick: function () {
                    setOpen('list')
                    errSt[1](null)
                  },
                },
                '← Sessions',
              )
            : h(Seg, {
                value: open,
                onChange: function (v) {
                  setOpen(v)
                  errSt[1](null)
                },
                options: [
                  { value: 'current', label: 'This session' },
                  { value: 'list', label: 'Sessions' + (home.sessions.length ? ' ' + home.sessions.length : '') },
                ],
              }),
          h('span', { className: 'sr-sp' }),
          h(
            'button',
            {
              type: 'button',
              className: 'sr-link',
              title: 'Reload',
              onClick: function () {
                load()
              },
            },
            '↻',
          ),
        )

        var body
        var picked = listCwd[0] && listCwd[0] !== home.cwd
        if (open === 'list')
          body =
            picked && !listRows[0]
              ? h(Progress, { label: 'Reading sessions…' })
              : h(SessionList, {
                  cwd: picked ? listCwd[0] : home.cwd,
                  sessions: picked ? listRows[0] : home.sessions,
                  projects: projects[0],
                  onPickerOpen: loadProjects,
                  onPick: function (cwd) {
                    listCwd[1](cwd === home.cwd ? null : cwd)
                  },
                  onOpen: openSession,
                })
        else if (open === 'current') {
          body = home.current
            ? h(RecapView, {
                data: home.current,
                canWrite: home.canWrite,
                busy: busySt[0],
                error: errSt[0],
                onWrite: function () {
                  write(home.current.session, !!(home.current.session.recap && home.current.session.recap.fresh))
                },
              })
            : h(
                'p',
                { className: 'sr-muted' },
                'This session has no saved transcript yet. Recap it after a turn, or pick another session.',
              )
        } else if (other[0]) {
          body = h(RecapView, {
            data: other[0],
            canWrite: home.canWrite,
            busy: busySt[0],
            error: errSt[0],
            onWrite: function () {
              write(open, !!(other[0].session.recap && other[0].session.recap.fresh))
            },
          })
        } else body = errSt[0] ? h('div', { className: 'sr-err' }, errSt[0]) : h(Progress, { label: 'Opening…' })

        return h(
          'div',
          { className: 'sr', 'data-session-recap': typeof open === 'object' ? 'session' : open },
          top,
          body,
        )
      }
    }

    function RecapTitle(props) {
      var info = props.useTabInfo && props.useTabInfo()
      return (info && info.tab && info.tab.title) || 'Session recap'
    }

    exports.name = ID
    exports.inject = ['slots', 'sidebarRightTabs']
    exports.apply = function apply(ctx) {
      ctx.effect(function () {
        return ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          priority: 'extension',
          title: function () {
            return 'Session recap'
          },
          guide: [
            {
              id: 'recap',
              order: 60,
              title: function () {
                return 'Session recap'
              },
              description: function () {
                return 'Intent, decisions and open threads of this session'
              },
            },
          ],
        })
      }, 'session-recap: tab type')
      var Body = makeBody(ctx)
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.pane.tab', function () {
          return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID }, Body)
        })
      }, 'session-recap: tab body')
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.pane.tab.title', function () {
          return ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: ID }, RecapTitle)
        })
      }, 'session-recap: tab title')
    }

    return module.exports
  },
})
