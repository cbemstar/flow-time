/* ============================================================
   Flow — in-place confirmation
   Ported from rare-ui's delete-button (React) to vanilla, using
   the Motion instance the app already vendors.

   A native confirm() blocks the page, drops the app's typography
   and looks like a browser error. This asks in the same spot the
   button lives, so the answer stays next to the question.
   ============================================================ */

import { anim, EASE, DUR, reduced } from '/anim.js';

let openConfirm = null;   // only ever one at a time

/**
 * Ask for confirmation in place of `btn`.
 *
 * @param {HTMLElement} btn      the control being confirmed
 * @param {object}      opts
 * @param {string}      opts.prompt        short question, e.g. "Delete?"
 * @param {string}      opts.confirmLabel  the verb on the affirmative button
 * @param {Array<{label:string, value:*, danger?:boolean}>} opts.choices
 * @returns {Promise<*>} the chosen value, or null if dismissed
 */
export function confirmInline(btn, { prompt = 'Are you sure?', confirmLabel = 'Delete', choices } = {}) {
  // the button repeats the verb, so it never reads "Delete" under "Clear history?"
  const opts = choices || [{ label: confirmLabel, value: true, danger: true }];
  closeConfirm();

  return new Promise((resolve) => {
    const pop = document.createElement('div');
    pop.className = 'cf-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', prompt);

    const q = document.createElement('span');
    q.className = 'cf-q';
    q.textContent = prompt;
    pop.appendChild(q);

    for (const c of opts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cf-go' + (c.danger ? ' is-danger' : '');
      b.textContent = c.label;
      b.addEventListener('click', (e) => { e.stopPropagation(); settle(c.value); });
      pop.appendChild(b);
    }

    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'cf-no';
    no.setAttribute('aria-label', 'Cancel');
    no.innerHTML = `<svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`;
    no.addEventListener('click', (e) => { e.stopPropagation(); settle(null); });
    pop.appendChild(no);

    document.body.appendChild(pop);
    place(pop, btn);

    // A confirmation that scrolls away from its button is worse than none.
    const reposition = () => place(pop, btn);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);

    const onKey = (e) => {
      if (e.key === 'Escape')  { e.preventDefault(); e.stopPropagation(); settle(null); }
      if (e.key === 'Enter')   { e.preventDefault(); settle(opts[0].value); }
    };
    // capture: the editor has its own Escape handler that would close the modal
    document.addEventListener('keydown', onKey, true);

    const onAway = (e) => { if (!pop.contains(e.target) && e.target !== btn) settle(null); };
    setTimeout(() => document.addEventListener('pointerdown', onAway), 0);

    btn.setAttribute('aria-expanded', 'true');
    anim(pop, { opacity: [0, 1], y: [-4, 0], scale: [0.94, 1] },
      { duration: DUR.sm, ease: EASE.out });
    (pop.querySelector('.cf-go')).focus();

    let done = false;
    function settle(value) {
      if (done) return;
      done = true;
      openConfirm = null;
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onAway);
      btn.setAttribute('aria-expanded', 'false');
      const gone = () => { pop.remove(); resolve(value); };
      if (reduced()) return gone();
      anim(pop, { opacity: [1, 0], scale: [1, 0.97] }, { duration: DUR.xs, ease: EASE.in })
        .then(gone);
    }

    openConfirm = settle;
  });
}

export function closeConfirm() {
  if (openConfirm) openConfirm(null);
}

/** Pin the bubble above its button, nudged inward if it would clip. */
function place(pop, btn) {
  const b = btn.getBoundingClientRect();
  const w = pop.offsetWidth;
  const gap = 8;
  let left = b.left + b.width / 2 - w / 2;
  left = Math.max(gap, Math.min(left, window.innerWidth - w - gap));
  let top = b.top - pop.offsetHeight - gap;
  if (top < gap) top = b.bottom + gap;      // flip under when there is no room above
  pop.style.left = Math.round(left) + 'px';
  pop.style.top  = Math.round(top) + 'px';
}
