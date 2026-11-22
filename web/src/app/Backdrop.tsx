import { useEffect, useRef } from 'react';
/** Фон приложения из макета: три размытых свечения и тор Ореола.
 *  Тор «живой», но переливается целиком: два градиента медленно вращаются навстречу друг другу,
 *  второй плавно проявляется и гаснет — цвет перетекает по всему кольцу сразу, без бегущих бликов. */
/** Раскладка фона: десктоп 1440×900 и телефон 390×844 (Figma «Mobile · …»: тор 520×312 у нижнего края). */
const LAYOUT = {
  desktop: {
    box: '0 0 1440 900',
    glowBlur: 90,
    torusBlur: 28,
    glows: [
      [210, 68, 410, 328],
      [1280, 724, 380, 304],
      [680, 828, 260, 208],
    ],
    ring: { transform: 'translate(199.09 386.37) rotate(-24)', cx: 450, cy: 270, rx: 425, ry: 245, w: 50, hl: 18 },
  },
  mobile: {
    box: '0 0 390 844',
    glowBlur: 90,
    torusBlur: 34,
    glows: [
      [10, 30, 310, 250],
      [370, 770, 260, 210],
      [70, 530, 210, 170],
    ],
    // Figma: эллипс 520×312 в (-105.97, 433.24), повёрнут на 24°, обводка 50 внутрь
    ring: { transform: 'translate(-105.97 433.24) rotate(-24)', cx: 260, cy: 156, rx: 235, ry: 131, w: 50, hl: 10 },
  },
};

/** Фон — один слой; цвета берёт из темы страницы. При смене темы его меняет сам «разлив» (View Transition),
 *  поэтому своего перехода у фона нет: внутри круга он сразу новый. */
export function Backdrop({ torus = 0.35, mobile = false }: { torus?: number; mobile?: boolean }) {
  return (
    <div className="backdrop" aria-hidden="true">
      <Layer th="one" torus={torus} mobile={mobile} />
    </div>
  );
}

function Layer({ th, torus, mobile }: { th: string; torus: number; mobile: boolean }) {
  // На телефоне внутри SVG ничего не анимируем: любой новый кадр внутри него заново считает размытие тора
  // (feGaussianBlur на пол-экрана) — Safari грел телефон. «Живость» там даёт сдвиг всего слоя на GPU (styles.css).
  const live = !mobile;
  const svgRef = useRef<SVGSVGElement>(null);
  // Фон выключен — SMIL-анимации на паузе, а не крутятся под нулевой прозрачностью
  useEffect(() => {
    const html = document.documentElement;
    const sync = () => {
      const svg = svgRef.current;
      if (!svg) return;
      if (html.dataset.backdrop === 'off') svg.pauseAnimations();
      else svg.unpauseAnimations();
    };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(html, { attributes: true, attributeFilter: ['data-backdrop'] });
    return () => mo.disconnect();
  }, []);
  const L = LAYOUT[mobile ? 'mobile' : 'desktop'];
  const r = L.ring;
  const id = (n: string) => `bd-${th}-${n}`;
  return (
    <div className={'bd-layer ' + th + (mobile ? ' m' : '')}>
      <svg ref={svgRef} viewBox={L.box} preserveAspectRatio="xMidYMid slice">
        <defs>
          {/* Свечения — радиальные градиенты, а не размытие фильтром: фильтр перерисовывался при каждой смене темы
              и перерисовке страницы, и пятна на миг появлялись резкими («мигали»). Градиент рисуется сразу мягким. */}
          {(['glow-1', 'glow-2', 'glow-3'] as const).map((g) => (
            <radialGradient key={g} id={id(g)}>
              <stop offset="0" stopColor={`var(--${g})`} />
              <stop offset="0.45" stopColor={`var(--${g})`} stopOpacity="0.92" />
              <stop offset="0.7" stopColor={`var(--${g})`} stopOpacity="0.45" />
              <stop offset="0.86" stopColor={`var(--${g})`} stopOpacity="0.12" />
              <stop offset="1" stopColor={`var(--${g})`} stopOpacity="0" />
            </radialGradient>
          ))}
          <filter id={id('torus')} x="-30%" y="-40%" width="160%" height="180%">
            <feGaussianBlur stdDeviation={L.torusBlur} />
          </filter>
          <linearGradient id={id('torus-g')} x1="0" y1="0" x2="1" y2="0">
            <stop stopColor="var(--glow-3)" />
            <stop offset="0.5" stopColor="var(--glow-1)" />
            <stop offset="1" stopColor="var(--glow-2)" />
            {live && <animateTransform attributeName="gradientTransform" type="rotate" from="0 0.5 0.5" to="360 0.5 0.5" dur="48s" repeatCount="indefinite" />}
          </linearGradient>
          <linearGradient id={id('torus-g2')} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="var(--glow-2)" />
            <stop offset="0.5" stopColor="var(--glow-3)" />
            <stop offset="1" stopColor="var(--glow-1)" />
            {live && <animateTransform attributeName="gradientTransform" type="rotate" from="360 0.5 0.5" to="0 0.5 0.5" dur="64s" repeatCount="indefinite" />}
          </linearGradient>
        </defs>
        <ellipse className="bd-glow a" cx={L.glows[0][0]} cy={L.glows[0][1]} rx={L.glows[0][2] + 2 * L.glowBlur} ry={L.glows[0][3] + 2 * L.glowBlur} fill={`url(#${id('glow-1')})`} opacity="0.35" />
        <ellipse className="bd-glow b" cx={L.glows[1][0]} cy={L.glows[1][1]} rx={L.glows[1][2] + 2 * L.glowBlur} ry={L.glows[1][3] + 2 * L.glowBlur} fill={`url(#${id('glow-2')})`} opacity="0.3" />
        <ellipse className="bd-glow c" cx={L.glows[2][0]} cy={L.glows[2][1]} rx={L.glows[2][2] + 2 * L.glowBlur} ry={L.glows[2][3] + 2 * L.glowBlur} fill={`url(#${id('glow-3')})`} opacity="0.16" />
        {/* Halo torus: эллипс 900×540, повёрнут на 24°, обводка 50 внутрь */}
        {/* На телефоне кольцо занимает пол-экрана — делаем его прозрачнее, чтобы фон не был «плотным» */}
        <g className={mobile ? 'bd-ring m' : 'bd-ring'} opacity={mobile ? torus * 0.6 : torus}>
          <g filter={`url(#${id('torus')})`} className="bd-torus">
            <g transform={r.transform}>
              <ellipse cx={r.cx} cy={r.cy} rx={r.rx} ry={r.ry} fill="none" stroke={`url(#${id('torus-g')})`} strokeWidth={r.w} />
              {/* Второй слой цвета: всё кольцо целиком плавно перетекает в другие оттенки */}
              <ellipse cx={r.cx} cy={r.cy} rx={r.rx} ry={r.ry} fill="none" stroke={`url(#${id('torus-g2')})`} strokeWidth={r.w} opacity="0">
                {live && <animate attributeName="opacity" values="0;0.75;0" dur="22s" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1" repeatCount="indefinite" />}
              </ellipse>
              {/* Мягкое свечение всего кольца — дышит вместе с тором */}
              <ellipse cx={r.cx} cy={r.cy} rx={r.rx} ry={r.ry} fill="none" stroke="#ffffff" strokeWidth={r.hl} opacity="0.12">
                {live && <animate attributeName="opacity" values="0.06;0.22;0.06" dur="14s" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1" repeatCount="indefinite" />}
              </ellipse>
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
}
