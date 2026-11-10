// Storage in the app-private Filesystem Directory.Data: data.json, engine.json, pairing.json.
// Every write goes to a temp file first, then is renamed over the real one.
'use strict';

const Store = (() => {
  const plug = () => window.Capacitor.Plugins;
  const DIR = 'DATA';
  let chain = Promise.resolve();

  // Serialises all file work so two saves can never interleave.
  const queue = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  async function readText(name) {
    try {
      const r = await plug().Filesystem.readFile({ path: name, directory: DIR, encoding: 'utf8' });
      return typeof r.data === 'string' ? r.data : null;
    } catch (e) { return null; } // missing file
  }

  async function read(name) {
    const text = await queue(() => readText(name));
    if (text == null) return null;
    return JSON.parse(text);
  }

  async function writeNow(name, obj) {
    const F = plug().Filesystem;
    const tmp = name + '.tmp';
    await F.writeFile({ path: tmp, directory: DIR, encoding: 'utf8', data: JSON.stringify(obj) });
    try { await F.rename({ from: tmp, to: name, directory: DIR, toDirectory: DIR }); }
    catch (e) {
      await F.deleteFile({ path: name, directory: DIR }).catch(() => {});
      await F.rename({ from: tmp, to: name, directory: DIR, toDirectory: DIR });
    }
  }

  const write = (name, obj) => queue(() => writeNow(name, obj));
  const remove = name => queue(() => plug().Filesystem.deleteFile({ path: name, directory: DIR }).catch(() => {}));

  return { read, write, remove, saveData: proj => write('data.json', proj), saveEngine: s => write('engine.json', s) };
})();
