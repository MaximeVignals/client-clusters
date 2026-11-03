// Opt-in documentation capture. Uses the smoke runner's isolated fictional demo profile.
// Unlike normal tests, this mode allows map-tile downloads, retaining provider attribution.
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function captureDocs(win, js) {
  win.setContentSize(1600, 960);
  await js(`
    state.tab = 'groups'; state.selectedClientId = null; state.selectedGroupId = state.data.groups[0].id;
    renderAll(); renderDetail(); $('#list').scrollTop = 0; fitAll();
  `);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    ready = await js(`(() => {
      const tiles = [...document.querySelectorAll('.leaflet-tile')];
      return tiles.length >= 4 && tiles.every(tile => tile.complete && tile.naturalWidth > 1);
    })()`);
    if (ready) break;
  }
  if (!ready) throw new Error('Map tiles did not finish loading; keeping the existing documentation images.');
  // Let fitBounds finish and transient demo notifications expire before capturing the real page.
  await new Promise(resolve => setTimeout(resolve, 4000));
  for (const theme of ['light', 'dark']) {
    await js(`appAppearance.set('${theme}');`);
    await new Promise(resolve => setTimeout(resolve, 200));
    const destination = path.resolve(__dirname, `../docs/screenshot${theme === 'dark' ? '-dark' : ''}.png`);
    fs.writeFileSync(destination, (await win.webContents.capturePage()).toPNG());
    console.log(`Captured ${path.basename(destination)} with fictional demo data.`);
  }
};
