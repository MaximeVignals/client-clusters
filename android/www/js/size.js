// Window size classes (Material window size classes, in CSS px = dp): compact < 600, medium 600-840, expanded > 840.
// Loaded in <head> so <html data-size> is set before the first paint. Uses matchMedia listeners, never resize polling.
// Also tracks the Chromium Viewport Segments API (foldable hinge): optional, everything works without it.
'use strict';

const Layout = (() => {
  const mq = q => (window.matchMedia ? window.matchMedia(q) : { matches: false, media: 'not all', addEventListener() {} });
  const medium = mq('(min-width: 600px)'), expanded = mq('(min-width: 840.02px)');
  // Medium and narrower than ~710dp: the detail would get under 360dp next to the list, so layout.css docks it over the list.
  const narrow = mq('(min-width: 600px) and (max-width: 709.98px)');
  const hseg = mq('(horizontal-viewport-segments: 2)'), vseg = mq('(vertical-viewport-segments: 2)');
  const listeners = [];
  const size = () => (expanded.matches ? 'expanded' : medium.matches ? 'medium' : 'compact');
  const segments = () => ({ h: hseg.media !== 'not all' && hseg.matches, v: vseg.media !== 'not all' && vseg.matches });
  // A media feature the engine does not know is reported as "not all".
  const supported = hseg.media !== 'not all' && vseg.media !== 'not all';

  function apply() { document.documentElement.dataset.size = size(); }
  function changed() { apply(); listeners.forEach(f => { try { f(); } catch (e) { console.error(e); } }); }
  for (const m of [medium, expanded, narrow, hseg, vseg]) {
    if (m.addEventListener) m.addEventListener('change', changed); else if (m.addListener) m.addListener(changed);
  }
  apply();

  return { size, narrow: () => narrow.matches, segments, supported, onChange: f => { listeners.push(f); } };
})();
