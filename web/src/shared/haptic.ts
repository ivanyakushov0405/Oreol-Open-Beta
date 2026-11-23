/**
 * Light haptic feedback. Android uses navigator.vibrate. Safari on iPhone (iOS 17.4+) has no vibrate, but toggling
 * an <input switch> produces a system tick, so it is clicked programmatically through a label.
 */
let label: HTMLLabelElement | null = null;
export function haptic() {
  try {
    if (navigator.vibrate?.(12)) return;
    if (!label) {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      input.id = 'oreol-haptic';
      label = document.createElement('label');
      label.htmlFor = input.id;
      const box = document.createElement('div');
      box.setAttribute('aria-hidden', 'true');
      box.style.cssText = 'position:fixed;left:-100px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
      box.append(input, label);
      document.body.appendChild(box);
    }
    label.click();
  } catch {
    /* haptics are optional */
  }
}
