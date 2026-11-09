/* global importScripts, jsyaml, parseMap */
importScripts('vendor/js-yaml.min.js', 'mapparse.js');

self.onmessage = (ev) => {
  const { id, text } = ev.data;
  try {
    const model = parseMap(text, jsyaml);
    self.postMessage({ id, ok: true, model });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e && e.message || e) });
  }
};
