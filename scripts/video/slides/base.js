// Auto-fit: any element marked data-fit shrinks its font-size until its text fits the CSS box
// (max-height, or a fixed height; width is checked too), so last-minute copy edits can't overflow a slide.
(function () {
  function fit(el) {
    var min = parseFloat(el.getAttribute('data-fit-min')) || 22;
    el.style.fontSize = '';
    var cs = getComputedStyle(el);
    var size = parseFloat(cs.fontSize);
    var maxH = parseFloat(cs.maxHeight); // NaN when "none"
    function overflows() {
      var limitH = isNaN(maxH) ? el.clientHeight : maxH;
      // +3px tolerance: tight line-heights make scrollHeight exceed the line box by the glyph overhang
      return el.scrollHeight > limitH + 3 || el.scrollWidth > el.clientWidth + 1;
    }
    var guard = 100;
    while (guard-- > 0 && size > min && overflows()) {
      size -= 2;
      el.style.fontSize = size + 'px';
    }
  }
  function fitAll() { document.querySelectorAll('[data-fit]').forEach(fit); }
  window.addEventListener('load', fitAll);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitAll);
})();
