// Icons are <symbol>s defined once in index.html (24px grid, 2px stroke, round caps); this builds the <use> reference.
'use strict';

const Icon = {
  // Decorative by default (the button or text next to it carries the name).
  svg: (name, cls = '') => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true" focusable="false"><use href="#${name}"/></svg>`,
};
