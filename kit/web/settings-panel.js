// The Settings panel on an agent's page: the kit's web part, with settings-panel.css. A kit agent's page
// (page.ts's settingsPanel()) gets it from server.ts as /settings.js. Any page can use it: an element with
// data-settings-panel, <meta name="page-token"> with the token its server wants in x-token, and the API
// below on the same origin (the kit's settings-kit.ts serves it; another server can serve the same).
// It is built from GET /api/settings (the agent's schema, its values and defaults) and saves with
// POST /api/settings, sending only what changed. The server checks everything and is the authority;
// this shows each field with its default, keeps track of what changed, and puts each message beside
// the field it is about. No inline script or handler: the page's CSP allows scripts from 'self' only.
(() => {
  const root = document.querySelector('[data-settings-panel]');
  if (!root) return;
  const token = document.querySelector('meta[name="page-token"]')?.getAttribute('content') || '';
  const SCALAR = ['switch', 'whole', 'number', 'text', 'choice'];
  // settings-kit.ts's APPLIES_NOTE: beside a setting that isn't used at once.
  const APPLIES_NOTE = { restart: 'takes effect at the next start', reinstall: 'takes effect at the next install or update', admin: 'takes effect when installed as an administrator' };
  let ids = 0;
  const newId = () => `sf${++ids}`;

  /** An element: attributes (false and null left out), then children. */
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid);
    return e;
  }
  const msgEl = () => h('p', { class: 'sf-msg', id: newId(), hidden: true, 'aria-live': 'polite' });
  const describedBy = (el, ...elems) => el && el.setAttribute('aria-describedby', elems.filter(Boolean).map((x) => x.id).join(' '));
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  // ------------------------------------------------------------ values

  const isEmpty = (v) => v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0);

  /** A value as the server would keep it, for comparing: text trimmed, empty optional fields left out. */
  function canon(f, v) {
    if (v === null && f.nullable) return null;
    switch (f.kind) {
      case 'switch':
        return v === true;
      case 'whole':
      case 'number':
        return typeof v === 'number' ? v : v === undefined || v === null ? '' : String(v);
      case 'text': {
        const s = typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v);
        return s === '' && f.nullable ? null : s;
      }
      case 'choice':
        return v === undefined || v === null ? '' : String(v);
      case 'choices':
        return Array.isArray(v) ? f.options.map((o) => o.value).filter((o) => v.includes(o)) : [];
      case 'list':
        return Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
      case 'records':
        return Array.isArray(v) ? v.map((r) => canonFields(f.fields, r)) : [];
      case 'group':
        return canonFields(f.fields, v || {});
      case 'map': {
        const o = {};
        for (const [k, x] of Object.entries(v || {})) if (String(k).trim()) o[String(k).trim()] = String(x ?? '').trim();
        return o;
      }
    }
    return v;
  }
  function canonFields(fields, obj) {
    const o = {};
    for (const f of fields) {
      const raw = obj ? obj[f.key] : undefined;
      if (f.readOnly) {
        if (raw !== undefined) o[f.key] = raw;
        continue;
      }
      const c = canon(f, raw);
      if (f.optional && isEmpty(c)) continue;
      o[f.key] = c;
    }
    return o;
  }
  const same = (f, a, b) => JSON.stringify(canon(f, a)) === JSON.stringify(canon(f, b));

  /** A value in words, for "Default: ...". */
  function words(f, v) {
    if (v === null || v === undefined) return f.kind === 'text' ? 'empty' : f.nullable || 'none';
    const label = (x) => (f.options.find((o) => o.value === x) || { label: x }).label;
    const few = (list) => (list.length <= 4 ? list.join(', ') : `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`);
    switch (f.kind) {
      case 'switch':
        return v ? 'on' : 'off';
      case 'whole':
      case 'number':
        return `${v}${f.unit ? ` ${v === 1 ? f.unit.replace(/s$/, '') : f.unit}` : ''}`;
      case 'text':
        return v === '' ? 'empty' : v;
      case 'choice':
        return label(v);
      case 'choices':
        return v.length ? v.map(label).join(', ') : 'none';
      case 'list':
        return v.length ? few(v) : 'none';
      case 'records':
        return v.length ? (f.title ? few(v.map((r) => String(r[f.title]))) : `${v.length} ${v.length === 1 ? 'entry' : 'entries'}`) : 'none';
      case 'map': {
        const n = Object.keys(v).length;
        return n ? `${n} ${n === 1 ? 'entry' : 'entries'}` : 'none';
      }
    }
    return '';
  }

  /** What a new record's field starts as. */
  function blank(f) {
    if (f.nullable) return null;
    switch (f.kind) {
      case 'switch':
        return false;
      case 'choice':
        return f.options[0]?.value ?? '';
      case 'choices':
      case 'list':
      case 'records':
        return [];
      case 'group':
        return Object.fromEntries(f.fields.map((g) => [g.key, blank(g)]));
      case 'map':
        return {};
    }
    return '';
  }

  // ------------------------------------------------------------ editors
  // Each editor has `node`, get(), set(value), slot(path parts) for messages, and maybe `control` (its
  // one input) and tidy() (drops empty rows before saving, so the server's item numbers match the page's).

  function readOnly(f, v) {
    let value = v;
    const node = h('span', { class: 'muted' });
    // A time (an ISO string) is shown as its day.
    const show = () => (node.textContent = value === undefined || value === null || value === '' ? '—' : String(value).replace(/^(\d{4}-\d\d-\d\d)T[\d:.]+Z$/, '$1'));
    show();
    return { node, get: () => value, set: (x) => ((value = x), show()), slot: () => null };
  }

  function scalar(f, v, aria) {
    if (f.readOnly) return readOnly(f, v);
    let input;
    if (f.kind === 'switch') input = h('input', { type: 'checkbox', role: 'switch', 'data-keep': true });
    else if (f.kind === 'choice') input = h('select', {}, f.options.map((o) => h('option', { value: o.value, text: o.label })));
    else if (f.kind === 'whole' || f.kind === 'number')
      input = h('input', { type: 'number', min: f.min, max: f.max, step: f.kind === 'whole' ? 1 : 'any', inputmode: f.kind === 'whole' ? 'numeric' : 'decimal' });
    else input = h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', maxlength: f.maxLength || (f.path ? 1000 : 500), placeholder: f.placeholder });
    input.id = newId();
    if (aria) input.setAttribute('aria-label', aria);
    const ed = {
      node: input,
      control: input,
      get() {
        if (f.kind === 'switch') return input.checked;
        if (f.kind === 'whole' || f.kind === 'number') {
          const t = input.value.trim();
          if (t === '') return f.nullable ? null : '';
          const n = Number(t);
          return Number.isFinite(n) ? n : t;
        }
        return input.value;
      },
      set(x) {
        if (f.kind === 'switch') input.checked = x === true;
        else input.value = x === undefined || x === null ? '' : String(x);
      },
      slot: () => null,
    };
    ed.set(v);
    return ed;
  }

  function choices(f, v) {
    const boxes = f.options.map((o) => ({ o, box: h('input', { type: 'checkbox', value: o.value, 'data-keep': true }) }));
    const node = h('div', { class: 'sf-choices' }, boxes.map(({ o, box }) => h('label', {}, box, h('span', { text: o.label }))));
    const ed = {
      node,
      control: boxes[0]?.box,
      get: () => boxes.filter((b) => b.box.checked).map((b) => b.o.value),
      set: (x) => boxes.forEach((b) => (b.box.checked = Array.isArray(x) && x.includes(b.o.value))),
      slot: () => null,
    };
    ed.set(v);
    return ed;
  }

  /** The "Automatic" (or "None") box of a setting that may be null: ticked, the editor below is hidden. */
  function nullBox(f, body) {
    const box = h('input', { type: 'checkbox', 'data-keep': true });
    box.addEventListener('change', () => (body.hidden = box.checked));
    return { box, node: h('label', { class: 'sf-switch' }, box, h('span', { text: f.nullable })), set: (isNull) => ((box.checked = isNull), (body.hidden = isNull)) };
  }

  function removeButton(noun, i, onClick) {
    const b = h('button', { type: 'button', class: 'quiet small', text: 'Remove', 'aria-label': `Remove ${noun} ${i + 1}` });
    b.addEventListener('click', onClick);
    return b;
  }

  function list(f, v) {
    const noun = f.item.label.toLowerCase();
    const ul = h('ul', { class: 'sf-list' });
    const add = h('button', { type: 'button', class: 'quiet small', text: `Add ${noun}` });
    const body = h('div', {}, ul, add);
    const auto = f.nullable ? nullBox(f, body) : null;
    const node = h('div', {}, auto?.node, body);
    let rows = [];
    const values = () => rows.map((r) => r.input.value);
    function draw(vals) {
      rows = vals.map((x, i) => {
        const input = h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', maxlength: f.item.maxLength || (f.item.path ? 1000 : 500), placeholder: f.item.placeholder, 'aria-label': `${f.item.label} ${i + 1}` });
        input.value = x;
        const msg = msgEl();
        describedBy(input, msg);
        const rm = removeButton(noun, i, () => {
          const next = values();
          next.splice(i, 1);
          draw(next);
          (rows[i]?.input || add).focus();
          changed();
        });
        return { li: h('li', {}, h('div', { class: 'sf-item' }, input, rm), msg), input, msg };
      });
      ul.replaceChildren(...rows.map((r) => r.li));
    }
    add.addEventListener('click', () => {
      draw([...values(), '']);
      rows.at(-1).input.focus();
      changed();
    });
    const ed = {
      node,
      control: auto?.box,
      get: () => (auto?.box.checked ? null : values()),
      set(x) {
        auto?.set(x === null);
        draw(Array.isArray(x) ? x.map(String) : []);
      },
      tidy() {
        if (values().some((s) => !s.trim())) draw(values().filter((s) => s.trim()));
      },
      slot(parts) {
        const r = rows[Number(parts[0])];
        return r ? { msg: r.msg, control: r.input } : null;
      },
    };
    ed.set(v);
    return ed;
  }

  function records(f, v) {
    const noun = (f.noun || 'entry').toLowerCase();
    const flat = f.fields.every((g) => SCALAR.includes(g.kind));
    const add = h('button', { type: 'button', class: 'quiet small', text: `Add ${noun}` });
    const tbody = h('tbody');
    const stack = h('div');
    const node = flat
      ? h('div', {}, h('div', { class: 'sf-scroll' }, h('table', { class: 'sf-table' }, h('thead', {}, h('tr', {}, f.fields.map((g) => h('th', { scope: 'col', text: g.label })), h('th', {}))), tbody)), add)
      : h('div', {}, stack, add);
    let rows = [];
    const values = () => rows.map((r) => Object.fromEntries(f.fields.map((g) => [g.key, r.parts[g.key].ed.get()])));
    const title = (rec, i) => (f.title && rec[f.title] ? String(rec[f.title]) : `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${i + 1}`);
    // A record of many fields is folded to its title; which are open survives adding and removing.
    const opened = () => rows.map((r) => !!r.node.open);
    function draw(vals, open = []) {
      rows = vals.map((rec, i) => {
        const parts = {};
        const remove = () => {
          const next = values();
          const keep = opened();
          next.splice(i, 1);
          keep.splice(i, 1);
          draw(next, keep);
          (rows[i]?.summary || rows[i]?.first || add).focus();
          changed();
        };
        const rowMsg = msgEl();
        if (flat) {
          const tr = h('tr');
          for (const g of f.fields) {
            const ed = scalar(g, rec[g.key], `${g.label}, ${noun} ${i + 1}`);
            const msg = msgEl();
            describedBy(ed.control, msg);
            parts[g.key] = { ed, slot: () => ({ msg, control: ed.control }) };
            tr.append(h('td', { 'data-label': g.label }, ed.node, msg));
          }
          tr.append(h('td', {}, removeButton(noun, i, remove), rowMsg));
          return { node: tr, parts, rowMsg, first: Object.values(parts).find((p) => p.ed.control)?.ed.control };
        }
        const summary = h('summary', { text: title(rec, i) });
        const box = h('details', { class: 'sf-record' }, summary);
        box.open = !!open[i];
        const fields = h('div', { role: 'group', 'aria-label': title(rec, i) });
        for (const g of f.fields) {
          const b = block(g, rec[g.key], undefined, {});
          parts[g.key] = { ed: b.ed, slot: b.slot };
          fields.append(b.node);
        }
        const titleEd = f.title && parts[f.title]?.ed;
        titleEd?.control?.addEventListener('input', () => (summary.textContent = title({ [f.title]: titleEd.get() }, i)));
        box.append(fields, h('div', { class: 'row' }, removeButton(noun, i, remove)), rowMsg);
        return { node: box, summary, parts, rowMsg, first: Object.values(parts).find((p) => p.ed.control)?.ed.control };
      });
      (flat ? tbody : stack).replaceChildren(...rows.map((r) => r.node));
    }
    add.addEventListener('click', () => {
      const fresh = clone(f.blank) || Object.fromEntries(f.fields.map((g) => [g.key, blank(g)]));
      draw([...values(), fresh], [...opened(), true]);
      rows.at(-1).first?.focus();
      changed();
    });
    const ed = {
      node,
      get: values,
      set: (x) => draw(Array.isArray(x) ? clone(x) : []),
      tidy() {
        const vals = values();
        const open = opened();
        const keep = vals.map((r) => f.fields.some((g) => !g.readOnly && g.kind !== 'switch' && !isEmpty(canon(g, r[g.key]))));
        if (keep.includes(false)) draw(vals.filter((_, i) => keep[i]), open.filter((_, i) => keep[i]));
        for (const r of rows) for (const p of Object.values(r.parts)) p.ed.tidy?.();
      },
      slot(parts) {
        const r = rows[Number(parts[0])];
        if (!r) return null;
        const p = r.parts[parts[1]];
        return (p && p.slot(parts.slice(2))) || { msg: r.rowMsg };
      },
    };
    ed.set(v);
    return ed;
  }

  function map(f, v) {
    const add = h('button', { type: 'button', class: 'quiet small', text: `Add ${f.keyLabel.toLowerCase()}` });
    const tbody = h('tbody');
    const node = h('div', {}, h('div', { class: 'sf-scroll' }, h('table', { class: 'sf-table' }, h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: f.keyLabel }), h('th', { scope: 'col', text: f.valueLabel }), h('th', {}))), tbody)), add);
    let rows = [];
    const entries = () => rows.map((r) => [r.key.value, r.value.value]);
    function draw(list) {
      rows = list.map(([k, x], i) => {
        const key = h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': `${f.keyLabel} ${i + 1}` });
        const value = h('input', { type: 'text', autocomplete: 'off', 'aria-label': `${f.valueLabel} ${i + 1}` });
        key.value = k;
        value.value = x;
        const km = msgEl();
        const vm = msgEl();
        describedBy(key, km);
        describedBy(value, vm);
        const rm = removeButton(f.keyLabel.toLowerCase(), i, () => {
          const next = entries();
          next.splice(i, 1);
          draw(next);
          (rows[i]?.key || add).focus();
          changed();
        });
        return { tr: h('tr', {}, h('td', { 'data-label': f.keyLabel }, key, km), h('td', { 'data-label': f.valueLabel }, value, vm), h('td', {}, rm)), key, value, km, vm };
      });
      tbody.replaceChildren(...rows.map((r) => r.tr));
    }
    add.addEventListener('click', () => {
      draw([...entries(), ['', '']]);
      rows.at(-1).key.focus();
      changed();
    });
    const ed = {
      node,
      get: () => Object.fromEntries(entries()),
      set: (x) => draw(Object.entries(x || {}).map(([k, y]) => [k, String(y ?? '')])),
      tidy() {
        if (entries().some(([k, x]) => !k.trim() && !x.trim())) draw(entries().filter(([k, x]) => k.trim() || x.trim()));
      },
      slot(parts) {
        const r = rows[Number(parts[0])];
        return r ? (parts[1] === 'value' ? { msg: r.vm, control: r.value } : { msg: r.km, control: r.key }) : null;
      },
    };
    ed.set(v);
    return ed;
  }

  function group(f, v, def, opts) {
    const inner = h('div');
    const none = f.nullable ? nullBox(f, inner) : null;
    const kids = {};
    for (const g of f.fields) {
      const savedKid = opts.saved ? () => opts.saved()?.[g.key] : undefined;
      const b = block(g, v ? v[g.key] : blank(g), def ? def[g.key] : undefined, { showDefault: opts.showDefault && !!def, saved: savedKid });
      kids[g.key] = b;
      inner.append(b.node);
    }
    const ed = {
      node: h('div', {}, none?.node, inner),
      control: none?.box,
      kids,
      get: () => (none?.box.checked ? null : Object.fromEntries(f.fields.map((g) => [g.key, kids[g.key].ed.get()]))),
      set(x) {
        none?.set(x === null);
        for (const g of f.fields) kids[g.key].ed.set(x ? x[g.key] : blank(g));
      },
      tidy: () => Object.values(kids).forEach((b) => b.ed.tidy?.()),
      slot: (parts) => (kids[parts[0]] ? kids[parts[0]].slot(parts.slice(1)) : null),
    };
    none?.set(v === null);
    return ed;
  }

  // ------------------------------------------------------------ one field

  /** Tracked fields: each one's value is compared with the saved one, to mark it changed. */
  let tracked = [];

  /**
   * A field with its label, help and messages; with `showDefault`, its default and "Reset to default".
   * Settings and the fields of a settings group show their defaults; the fields of a record don't.
   */
  function block(f, value, def, opts) {
    const node = h('div', { class: 'sf', 'data-key': f.key });
    const msg = msgEl();
    const help = f.help ? h('p', { class: 'sf-help', id: newId(), text: f.help }) : null;
    const meta = h('p', { class: 'sf-meta' });
    const badge = h('span', { class: 'badge npu sf-changed', text: 'changed' });
    let ed;
    if (SCALAR.includes(f.kind)) {
      ed = scalar(f, value);
      const head =
        f.kind === 'switch' && !f.readOnly
          ? h('div', { class: 'sf-head' }, h('label', { class: 'sf-switch' }, ed.control, h('span', { text: f.label })), badge)
          : h('div', { class: 'sf-head' }, f.readOnly ? h('span', { class: 'sf-name', text: f.label }) : h('label', { for: ed.control.id, text: f.label }), badge);
      node.append(head);
      if (f.kind !== 'switch' || f.readOnly) node.append(h('div', { class: 'sf-control' }, ed.node, f.unit ? h('span', { class: 'muted', text: f.unit }) : null));
      node.append(help || '', meta, msg);
      describedBy(ed.control, help, msg);
    } else {
      ed =
        f.kind === 'choices' ? choices(f, value)
        : f.kind === 'list' ? list(f, value)
        : f.kind === 'records' ? records(f, value)
        : f.kind === 'map' ? map(f, value)
        : group(f, value, def, opts);
      const fs = h('fieldset', { class: f.kind === 'group' ? 'sf-group' : 'sf-plain' }, h('legend', {}, h('span', { text: f.label }), ' ', badge), help, ed.node, meta, msg);
      describedBy(fs, help, msg);
      node.append(fs);
    }
    if (f.kind === 'text' && (f.nullable || f.empty)) meta.append(h('span', { text: `Empty: ${f.nullable || f.empty}.` }));
    if (opts.showDefault && f.kind !== 'group' && !f.readOnly) {
      meta.append(h('span', { text: `Default: ${words(f, def)}.` }));
      const reset = h('button', { type: 'button', class: 'link', text: 'Reset to default' });
      reset.addEventListener('click', () => {
        ed.set(clone(def));
        changed();
        (ed.control || node.querySelector('input, select') || reset).focus();
      });
      meta.append(reset);
      tracked.push({ f, ed, node, def, reset, saved: opts.saved });
    } else if (opts.saved) tracked.push({ f, ed, node, saved: opts.saved });
    if (opts.top && APPLIES_NOTE[f.applies]) meta.append(h('span', { class: 'badge warn', text: APPLIES_NOTE[f.applies] }));
    if (!meta.childNodes.length) meta.remove();
    const slot = (parts) => (parts.length && ed.slot(parts)) || { msg, control: ed.control };
    return { node, ed, msg, slot };
  }

  // ------------------------------------------------------------ the panel

  let data = null;
  let saved = {};
  let blocks = [];
  const intro = h('p', { class: 'sf-intro muted' });
  const problems = h('div', { class: 'sf-problems' });
  const general = h('p', { class: 'sf-msg error', id: newId(), hidden: true, role: 'alert', tabindex: '-1' });
  const form = h('form', { class: 'sf-form', id: newId(), novalidate: true });
  // Outside the form (in the bar that stays in view), but its submit button: Enter in a field saves too.
  const save = h('button', { type: 'submit', form: form.id, text: 'Save' });
  const cancel = h('button', { type: 'button', class: 'quiet', text: 'Cancel' });
  const resetAll = h('button', { type: 'button', class: 'link', text: 'Set every field to its default' });
  const status = h('p', { class: 'sf-status muted', role: 'status', 'aria-live': 'polite' });
  const actions = h('div', { class: 'sf-actions' }, save, cancel, status, h('span', { class: 'sf-spacer' }), resetAll);

  function say(text, isError) {
    status.textContent = text;
    status.className = `sf-status${isError ? ' error' : ' muted'}`;
  }

  function changed() {
    let dirty = false;
    for (const t of tracked) {
      const now = t.ed.get();
      const isChanged = !same(t.f, now, t.saved());
      t.node.classList.toggle('is-changed', isChanged);
      if (t.reset) t.reset.disabled = t.def === undefined || same(t.f, now, t.def);
    }
    for (const b of blocks) if (!same(b.f, b.ed.get(), saved[b.f.key])) dirty = true;
    save.disabled = cancel.disabled = !dirty;
    if (dirty) root.setAttribute('data-dirty', '');
    else root.removeAttribute('data-dirty');
  }

  function render() {
    tracked = [];
    const values = data.values;
    const defaults = data.defaults;
    blocks = data.schema.map((f) => ({ f, ...block(f, clone(values[f.key]), defaults[f.key], { showDefault: true, top: true, saved: () => saved[f.key] }) }));
    form.replaceChildren(...blocks.map((b) => b.node));
    changed();
  }

  function clearMessages() {
    for (const m of root.querySelectorAll('.sf-msg')) {
      m.hidden = true;
      m.textContent = '';
      m.classList.remove('error', 'warning');
    }
    general.classList.add('error');
    for (const el of root.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
  }

  /** Messages by path ("folders.2", "npu.pieceTokens"; "" for the whole form), each beside its field. */
  function show(messages, kind) {
    for (const [path, text] of Object.entries(messages || {})) {
      let slot = null;
      if (path !== '') {
        const [key, ...rest] = path.split('.');
        const b = blocks.find((x) => x.f.key === key);
        slot = b ? b.slot(rest) : null;
      }
      const m = slot ? slot.msg : general;
      if (m.textContent && kind === 'warning' && m.classList.contains('error')) continue;
      // A message inside a folded record unfolds it.
      for (let d = m.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
      m.textContent = m.textContent && !m.hidden ? `${m.textContent} ${text}` : text;
      m.hidden = false;
      m.classList.remove('error', 'warning');
      m.classList.add(kind);
      if (kind === 'error' && slot?.control) slot.control.setAttribute('aria-invalid', 'true');
    }
  }

  // The file's path and its problems' own words are a developer's: the server sends them only while the manor's
  // Developer options are on (settings-kit.ts), and an empty `file` says they're off.
  function showProblems() {
    const label = data.file ? 'settings.json' : 'Settings';
    problems.replaceChildren(
      ...(data.problems || []).map((p) => h('p', { class: 'sf-msg warning' }, h('span', { class: 'badge warn', text: label }), ' ', p)),
    );
  }

  async function load() {
    say('');
    try {
      const r = await fetch('/api/settings', { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      data = await r.json();
    } catch (e) {
      const retry = h('button', { type: 'button', class: 'quiet small', text: 'Try again' });
      retry.addEventListener('click', load);
      root.replaceChildren(h('p', { class: 'sf-msg error', text: `The settings couldn't be loaded: ${e.message}.` }), retry);
      return;
    }
    saved = clone(data.values);
    const later = [...new Set(data.schema.map((f) => APPLIES_NOTE[f.applies]).filter(Boolean))];
    const usedFrom = data.usedFrom || 'from the next round on';
    intro.replaceChildren(
      ...(data.file ? ['Changes are checked and saved here, into ', h('code', { text: data.file })] : ['Changes are checked and saved here']),
      later.length ? `. They are used ${usedFrom}, except those marked ${later.map((n) => `"${n}"`).join(' or ')}.` : `. They are used ${usedFrom}.`,
    );
    root.replaceChildren(intro, problems, general, form, actions);
    showProblems();
    render();
    show(data.warnings, 'warning');
  }

  form.addEventListener('input', changed);
  form.addEventListener('change', changed);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMessages();
    for (const b of blocks) b.ed.tidy?.();
    const values = {};
    for (const b of blocks) {
      const now = canon(b.f, b.ed.get());
      if (!same(b.f, now, saved[b.f.key])) values[b.f.key] = now;
    }
    changed();
    if (!Object.keys(values).length) return say('Nothing to save.');
    save.disabled = true;
    say('Saving…');
    let r;
    let j = {};
    try {
      r = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify({ values }) });
      j = await r.json().catch(() => ({}));
    } catch (err) {
      save.disabled = false;
      return say(`Not saved: ${err.message}.`, true);
    }
    if (!r.ok) {
      save.disabled = false;
      show(j.errors || {}, 'error');
      say(j.error || `Not saved (${r.status}).`, true);
      const first = form.querySelector('[aria-invalid="true"]');
      (first || general).focus?.();
      return;
    }
    data.values = j.values;
    saved = clone(j.values);
    render();
    show(j.warnings, 'warning');
    say([j.message || 'Saved.', ...(j.notes || [])].join(' '));
  });
  cancel.addEventListener('click', () => {
    clearMessages();
    render();
    show(data.warnings, 'warning');
    say('Changes undone.');
  });
  resetAll.addEventListener('click', () => {
    for (const b of blocks) if (!b.f.readOnly) b.ed.set(clone(data.defaults[b.f.key]));
    changed();
    say('Every field shows its default now. Save to keep them, or Cancel.');
  });
  window.addEventListener('beforeunload', (e) => {
    if (root.hasAttribute('data-dirty')) e.preventDefault();
  });
  load();
})();
