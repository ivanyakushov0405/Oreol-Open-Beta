/** Лёгкий отклик вибрацией. Android — navigator.vibrate. В Safari на iPhone (iOS 17.4+) vibrate нет,
 *  но нажатие на переключатель <input switch> даёт системный «тик» — нажимаем его программно через label. */
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
    /* отклик не обязателен */
  }
}
