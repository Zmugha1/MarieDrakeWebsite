// The few behaviors the old plugins handled with scripts: mobile menu, FAQ
// accordions, the reviews slider, click-to-play videos, the accessibility toolbar.
(function () {
  var d = document;
  var $$ = function (s, r) { return Array.prototype.slice.call((r || d).querySelectorAll(s)); };

  // Mobile menu
  $$('.menu-toggle.main-header-menu-toggle').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', open);
      btn.classList.toggle('toggled', open);
      d.body.classList.toggle('ast-main-header-nav-open', open);
      $$('.ast-mobile-header-content').forEach(function (c) { c.style.display = open ? 'block' : ''; });
    });
  });
  $$('.ast-menu-toggle').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      var li = btn.closest('li');
      var open = !li.classList.contains('ast-submenu-expanded');
      li.classList.toggle('ast-submenu-expanded', open);
      btn.setAttribute('aria-expanded', open);
      var sub = li.querySelector(':scope > .sub-menu');
      if (sub) sub.style.display = open ? 'block' : '';
    });
  });

  // FAQ accordions
  $$('.elementor-accordion .elementor-tab-title').forEach(function (t) {
    var c = d.getElementById(t.getAttribute('aria-controls'));
    if (c) c.style.display = 'none';
    t.addEventListener('click', function () {
      var open = t.getAttribute('aria-expanded') !== 'true';
      t.setAttribute('aria-expanded', open);
      t.classList.toggle('elementor-active', open);
      if (c) { c.classList.toggle('elementor-active', open); c.style.display = open ? 'block' : 'none'; }
    });
  });

  // Reviews slider: one review at a time, dots to switch, advances every 8 seconds
  $$('.elementor-widget-testimonial-carousel .elementor-main-swiper').forEach(function (sw) {
    var slides = $$('.swiper-slide', sw);
    if (slides.length < 2) return;
    var i = 0;
    var dots = sw.parentNode.querySelector('.swiper-pagination');
    var show = function (n) {
      i = (n + slides.length) % slides.length;
      slides.forEach(function (s, k) { s.style.display = k === i ? 'block' : 'none'; });
      if (dots) $$('span', dots).forEach(function (b, k) { b.classList.toggle('swiper-pagination-bullet-active', k === i); });
    };
    if (dots) {
      dots.innerHTML = '';
      slides.forEach(function (_, k) {
        var b = d.createElement('span');
        b.className = 'swiper-pagination-bullet';
        b.setAttribute('role', 'button');
        b.setAttribute('aria-label', 'Go to review ' + (k + 1));
        b.addEventListener('click', function () { show(k); });
        dots.appendChild(b);
      });
    }
    show(0);
    var timer = setInterval(function () { show(i + 1); }, 8000);
    sw.addEventListener('mouseenter', function () { clearInterval(timer); });
  });

  // Click-to-play videos load YouTube only when clicked
  $$('[data-video]').forEach(function (w) {
    var overlay = w.querySelector('.elementor-custom-embed-image-overlay');
    var box = w.querySelector('.elementor-video');
    if (!overlay || !box) return;
    overlay.addEventListener('click', function () {
      var m = w.getAttribute('data-video').match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/);
      if (!m) { window.open(w.getAttribute('data-video'), '_blank'); return; }
      box.innerHTML = '<iframe src="https://www.youtube-nocookie.com/embed/' + m[1] + '?autoplay=1" allow="autoplay; encrypted-media" allowfullscreen title="Video" style="width:100%;height:100%;border:0"></iframe>';
      overlay.style.display = 'none';
    });
  });

  // Video lightbox for carousel slides
  var lightbox = function (url) {
    var m = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/);
    if (!m) { window.open(url, '_blank'); return; }
    var box = d.createElement('div');
    box.className = 'drake-lightbox';
    box.innerHTML = '<button type="button" aria-label="Close video">&times;</button><iframe src="https://www.youtube-nocookie.com/embed/' + m[1] + '?autoplay=1&rel=0" allow="autoplay; encrypted-media" allowfullscreen title="Video"></iframe>';
    var close = function () { box.remove(); d.removeEventListener('keydown', esc); };
    var esc = function (e) { if (e.key === 'Escape') close(); };
    box.addEventListener('click', function (e) { if (e.target === box || e.target.tagName === 'BUTTON') close(); });
    d.addEventListener('keydown', esc);
    d.body.appendChild(box);
  };
  $$('a[data-elementor-lightbox-video]').forEach(function (a) {
    a.addEventListener('click', function (e) { e.preventDefault(); lightbox(a.getAttribute('data-elementor-lightbox-video')); });
  });

  // Media carousel: arrows move one slide, auto-advance every 4 seconds
  $$('.elementor-widget-media-carousel').forEach(function (w) {
    var track = w.querySelector('.swiper-wrapper');
    if (!track) return;
    var step = function (dir) {
      var slide = track.querySelector('.swiper-slide');
      var by = slide ? slide.getBoundingClientRect().width + 10 : track.clientWidth;
      var end = track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
      if (dir > 0 && end) track.scrollLeft = 0; else track.scrollLeft += dir * by;
    };
    var prev = w.querySelector('.elementor-swiper-button-prev');
    var next = w.querySelector('.elementor-swiper-button-next');
    if (prev) prev.addEventListener('click', function () { step(-1); });
    if (next) next.addEventListener('click', function () { step(1); });
    var t = setInterval(function () { step(1); }, 4000);
    w.addEventListener('mouseenter', function () { clearInterval(t); });
  });

  // Forms: record which page the message came from
  $$('form[data-netlify] input[name="page"]').forEach(function (i) { i.value = location.pathname; });

  // Accessibility toolbar
  var bar = d.getElementById('pojo-a11y-toolbar');
  if (bar) {
    var KEY = 'drake-a11y';
    var state = {};
    try { state = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {}
    var sizes = [100, 120, 140, 160, 180, 200];
    var apply = function () {
      var b = d.body.classList;
      Array.prototype.slice.call(b).forEach(function (c) { if (/^pojo-a11y-/.test(c)) b.remove(c); });
      if (state.size) b.add('pojo-a11y-resize-font-' + state.size);
      ['grayscale', 'high-contrast', 'negative-contrast', 'light-background', 'links-underline', 'readable-font'].forEach(function (k) {
        if (state[k]) b.add('pojo-a11y-' + k);
      });
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
    };
    apply();
    bar.querySelector('.pojo-a11y-toolbar-toggle-link').addEventListener('click', function (e) {
      e.preventDefault();
      bar.classList.toggle('pojo-a11y-toolbar-open');
    });
    $$('[data-action]', bar).forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var act = a.getAttribute('data-action');
        var cur = sizes.indexOf(state.size || 100);
        if (act === 'resize-plus') state.size = sizes[Math.min(cur + 1, sizes.length - 1)];
        else if (act === 'resize-minus') state.size = sizes[Math.max(cur - 1, 0)];
        else if (act === 'reset') state = {};
        else {
          if (/contrast|background/.test(act)) { state['high-contrast'] = state['negative-contrast'] = state['light-background'] = false; }
          state[act] = !state[act];
        }
        if (state.size === 100) delete state.size;
        apply();
      });
    });
  }
})();
