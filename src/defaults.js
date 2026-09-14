// The chip on every editable control shows what the server would apply if the field were left
// alone. It cannot know that from a constant kept on this side: the defaults are the server's own,
// read once from GET /api/site-defaults, because the copy that used to live in SiteForm.jsx had
// already drifted from them — a nine-entry cache-extension list against the server's ten. What is
// left here is only the reading and the printing of that object.

export const at = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj)

// Two lists hold the same default when they hold the same members, not when they are in the same
// order: these are checkboxes, and unticking then reticking one leaves the list reordered. Counting
// distinct members rather than entries, so a repeated one cannot pass as a longer list.
const sameSet = (a, b) => new Set(a).size === new Set(b).size && a.every(x => b.includes(x))

// A blank is the default, and not as a convenience: `sanitizeSite` fills a blank docroot, index
// file or body limit from this same object, so an emptied field really does mean "whatever the
// server says". Rows (proxy, upstream, IP) are compared by the fields the chip governs.
export const isDefault = (value, def) =>
  Array.isArray(def) ? Array.isArray(value) && sameSet(value, def)
    : def && typeof def === 'object' ? Object.entries(def).every(([k, v]) => value?.[k] === v)
      : value === def || (value === '' && def !== '')

// A long value would push the caption off the line, so the chip falls back to the bare word and
// keeps the value in its title. A row defaults to a shape rather than a value, which has no short
// form at all. Booleans read as the switch they are — "default: on" beside a toggle, not "true".
export const fmt = v =>
  Array.isArray(v) ? (v.length ? v.join(' ') : 'none')
    : v && typeof v === 'object' ? ''
      : typeof v === 'boolean' ? (v ? 'on' : 'off')
        : v === '' ? 'blank' : String(v)

export const short = v => { const t = fmt(v); return t.length <= 22 ? t : '' }
