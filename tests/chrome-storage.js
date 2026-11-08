// A chrome.storage.local stand-in with Chrome's get() semantics, shared by the unit tests so none of them can pass or
// fail on a call style real Chrome answers differently:
//   get(null | undefined) -> a copy of everything stored
//   get('key')            -> { key: value } if stored, else {}
//   get(['a', 'b'])       -> the listed keys that are stored
//   get({ a: 1, b: 2 })   -> the defaults, overlaid with the stored values of those keys (and no other keys)
// set() fires the onChanged listeners with Chrome's { key: { oldValue, newValue } } shape and area 'local'.
function makeStorage(store, onChanged = []) {
  const has = (k) => Object.prototype.hasOwnProperty.call(store, k);
  const pick = (keys) => {
    const out = {};
    for (const k of keys) if (has(k)) out[k] = store[k];
    return out;
  };
  return {
    get: async (keys) => {
      if (keys == null) return { ...store };
      if (typeof keys === 'string') return pick([keys]);
      if (Array.isArray(keys)) return pick(keys);
      if (typeof keys === 'object') return { ...keys, ...pick(Object.keys(keys)) };
      throw new TypeError(`storage.get: unsupported keys ${typeof keys}`);
    },
    set: async (values) => {
      const changes = {};
      for (const [k, v] of Object.entries(values)) {
        changes[k] = { oldValue: store[k], newValue: v };
        store[k] = v;
      }
      for (const fn of onChanged) fn(changes, 'local');
    },
  };
}

module.exports = { makeStorage };
