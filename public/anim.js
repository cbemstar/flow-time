/* ============================================================
   Flow — motion layer
   Every entrance, exit and micro-interaction lives here so the
   app moves with one vocabulary instead of a dozen ad-hoc CSS
   transitions. Built on Motion (window.Motion, UMD).

   Overlays are animated by watching their `hidden` attribute
   rather than by rewriting ~20 call sites. Exits never touch
   `hidden` itself — they pin an inline `display` for the length
   of the animation — so there is no observer feedback loop.
   ============================================================ */

const M = window.Motion;
const mq = matchMedia('(prefers-reduced-motion: reduce)');
export const reduced = () => mq.matches;

export const EASE = {
  out:  [0.22, 0.61, 0.36, 1],   // standard — decelerate into place
  in:   [0.55, 0.06, 0.68, 0.19],
  soft: [0.33, 1.00, 0.68, 1],
};
export const DUR = { xs: 0.12, sm: 0.16, md: 0.22, lg: 0.3 };

/** animate(), but a no-op under reduced motion and safe if Motion is missing */
export function anim(el, keyframes, opts = {}) {
  if (!el) return Promise.resolve();
  if (!M || reduced()) return Promise.resolve();
  try { return M.animate(el, keyframes, opts).finished.catch(() => {}); }
  catch { return Promise.resolve(); }
}

/* ── overlay choreography ──────────────────────────────────── */

const OPEN = {
  dialog(el, card) {
    anim(el.querySelector('.modal-backdrop'), { opacity: [0, 1] }, { duration: DUR.md, ease: 'linear' });
    return anim(card, { opacity: [0, 1], y: [12, 0], scale: [0.985, 1] },
      { duration: DUR.md, ease: EASE.out });
  },
  menu(el) {
    return anim(el, { opacity: [0, 1], y: [-6, 0], scale: [0.96, 1] },
      { duration: DUR.sm, ease: EASE.out });
  },
  panel(el) {
    // Measure the natural width while it is on screen, animate up to it, then
    // hand sizing back to CSS — pinning an inline width would freeze the
    // panel at whatever it happened to be when it first opened.
    el.style.width = ''; el.style.flexBasis = '';
    const w = el.getBoundingClientRect().width + 'px';
    return anim(el, { opacity: [0, 1], width: ['0px', w], flexBasis: ['0px', w] },
      { duration: DUR.md, ease: EASE.out })
      .then(() => { el.style.width = ''; el.style.flexBasis = ''; });
  },
  dock(el) {
    // x stays pinned at -50%: these docks are centred by transform, and
    // animating y alone would otherwise drop the centring.
    return anim(el, { opacity: [0, 1], x: '-50%', y: [12, 0] },
      { type: 'spring', stiffness: 520, damping: 34 });
  },
};

const CLOSE = {
  dialog(el, card) {
    anim(el.querySelector('.modal-backdrop'), { opacity: [1, 0] }, { duration: DUR.sm, ease: 'linear' });
    return anim(card, { opacity: [1, 0], y: [0, 6], scale: [1, 0.99] },
      { duration: DUR.sm, ease: EASE.in });
  },
  menu(el) {
    return anim(el, { opacity: [1, 0], scale: [1, 0.97] },
      { duration: DUR.xs, ease: EASE.in });
  },
  panel(el) {
    const w = el.getBoundingClientRect().width + 'px';
    return anim(el, { opacity: [1, 0], width: [w, '0px'], flexBasis: [w, '0px'] },
      { duration: DUR.sm, ease: EASE.in })
      .then(() => { el.style.width = ''; el.style.flexBasis = ''; });
  },
  dock(el) {
    return anim(el, { opacity: [1, 0], x: '-50%', y: [0, 8] },
      { duration: DUR.xs, ease: EASE.in });
  },
};

/**
 * Animate an element whose visibility is driven by the `hidden`
 * attribute. On close we pin `display` inline (inline beats the
 * stylesheet's `[hidden] { display: none }`) so the exit can play
 * while `hidden` is already true — nothing writes `hidden`, so the
 * observer never re-enters.
 */
const OPEN_DISPLAY = { dialog: 'flex', menu: 'block', panel: 'flex', dock: 'flex' };

function watchOverlay(sel, kind, cardSel) {
  const el = document.querySelector(sel);
  if (!el) return;
  const card = () => (cardSel ? el.querySelector(cardSel) : el);
  let open = !el.hidden;
  let closing = null;

  if (kind === 'panel') el.style.overflow = 'hidden';

  new MutationObserver(() => {
    const want = !el.hidden;
    if (want === open) return;
    open = want;

    if (want) {
      if (closing) { closing.cancel(); closing = null; }
      el.style.display = '';
      // Record the open display now — by the time it closes, `hidden` is
      // already set and the computed value would just read `none`.
      el.dataset.animDisplay = getComputedStyle(el).display;
      OPEN[kind](el, card());
    } else {
      el.style.display = el.dataset.animDisplay || OPEN_DISPLAY[kind];
      let live = true;
      closing = { cancel() { live = false; el.style.display = ''; } };
      CLOSE[kind](el, card()).then(() => {
        if (!live) return;
        el.style.display = '';
        closing = null;
      });
    }
  }).observe(el, { attributes: true, attributeFilter: ['hidden'] });
}

/* ── entrances for freshly rendered lists ──────────────────── */

/** Stagger a set of nodes in. Cheap enough to run on every re-render. */
export function stagger(nodes, { y = 6, delay = 0.012, duration = DUR.sm } = {}) {
  if (!M || reduced()) return;
  const list = [...nodes].slice(0, 40);        // long lists animate the visible head only
  list.forEach((n, i) => {
    anim(n, { opacity: [0, 1], y: [y, 0] },
      { duration, ease: EASE.out, delay: i * delay });
  });
}

/** Collapse/expand a block by its own height. */
export function collapse(el, show, { duration = DUR.md } = {}) {
  if (!el) return Promise.resolve();
  if (!M || reduced()) return Promise.resolve();
  const h = el.scrollHeight;
  el.style.overflow = 'hidden';
  return anim(el,
    show ? { height: ['0px', h + 'px'], opacity: [0, 1] }
         : { height: [h + 'px', '0px'], opacity: [1, 0] },
    { duration, ease: show ? EASE.out : EASE.in },
  ).then(() => { el.style.overflow = ''; el.style.height = ''; });
}

/* ── micro-interactions ────────────────────────────────────── */

const PRESSABLE = '.block, .item, .btn, .btn-primary, .btn-ghost, .rail-btn, .td-pill, .swatch, .chip, .day-tab';

function pressFeedback() {
  if (!M || reduced()) return;
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest(PRESSABLE);
    if (!el || el.closest('[hidden]')) return;
    anim(el, { scale: 0.972 }, { duration: 0.07, ease: EASE.out });
    const release = () => {
      anim(el, { scale: 1 }, { type: 'spring', stiffness: 700, damping: 26 });
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  }, { passive: true });
}

/* ── boot ──────────────────────────────────────────────────── */

export function initAnimations() {
  if (!M) { console.warn('[anim] Motion not loaded — running without animation'); return; }

  watchOverlay('#taskModal',     'dialog', '.td-card');
  watchOverlay('#manageModal',   'dialog', '.mg-card');
  watchOverlay('#searchModal',   'dialog', '.search-card');
  watchOverlay('#helpModal',     'dialog', '.modal-card');
  watchOverlay('#settingsModal', 'dialog', '.modal-card');

  watchOverlay('#ctxMenu',    'menu');
  watchOverlay('#addNewMenu', 'menu');
  watchOverlay('#tdMenuPop',  'menu');

  watchOverlay('#activityPanel', 'panel');

  watchOverlay('#pickBar', 'dock');
  watchOverlay('#toast',   'dock');

  pressFeedback();
}

initAnimations();
