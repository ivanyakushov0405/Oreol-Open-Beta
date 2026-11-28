import { useEffect, useRef, useState } from 'react';
/** Torus colors drift as a whole: two gradients rotate in opposite directions and the second one fades in and out. */
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
    ring: { transform: 'translate(-105.97 433.24) rotate(-24)', cx: 260, cy: 156, rx: 235, ry: 131, w: 50, hl: 10 },
  },
};

/** No transition of its own: theme changes are animated by the View Transition reveal. */
export function Backdrop({ torus = 0.35, mobile = false }: { torus?: number; mobile?: boolean }) {
  return (
    <div className="backdrop" aria-hidden="true">
      <Layer th="one" torus={torus} mobile={mobile} />
    </div>
  );
}

function Layer({ th, torus, mobile }: { th: string; torus: number; mobile: boolean }) {
  // On phones nothing inside the SVG animates: every frame recomputes the half-screen blur and Safari overheats.
  // The motion comes from moving the whole layer on the GPU instead (styles.css).
  const live = !mobile;
  const svgRef = useRef<SVGSVGElement>(null);
  const [go, setGo] = useState(false);
  // The SVG animates on the main thread: on a first visit the bundle and the fonts keep it busy for a couple of
  // seconds and the ring stutters. It starts moving once the page has settled.
  useEffect(() => {
    let off = false;
    let idle = 0;
    const loaded = document.readyState === 'complete' ? Promise.resolve() : new Promise((r) => addEventListener('load', r, { once: true }));
    void Promise.all([loaded, document.fonts.ready]).then(() => {
      if (off) return;
      const start = () => !off && setGo(true);
      if ('requestIdleCallback' in window) idle = requestIdleCallback(start, { timeout: 1500 });
      else idle = setTimeout(start, 300) as unknown as number;
    });
    return () => {
      off = true;
      if ('cancelIdleCallback' in window) cancelIdleCallback(idle);
      clearTimeout(idle);
    };
  }, []);
  useEffect(() => {
    const html = document.documentElement;
    const sync = () => {
      const svg = svgRef.current;
      if (!svg) return;
      if (!go || html.dataset.backdrop === 'off') svg.pauseAnimations();
      else svg.unpauseAnimations();
    };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(html, { attributes: true, attributeFilter: ['data-backdrop'] });
    return () => mo.disconnect();
  }, [go]);
  const L = LAYOUT[mobile ? 'mobile' : 'desktop'];
  const r = L.ring;
  const id = (n: string) => `bd-${th}-${n}`;
  return (
    <div className={'bd-layer ' + th + (mobile ? ' m' : '') + (go ? '' : ' hold')}>
      <svg ref={svgRef} viewBox={L.box} preserveAspectRatio="xMidYMid slice">
        <defs>
          {/* Radial gradients instead of a blur filter: the filter re-rendered on every repaint and the glows flashed sharp. */}
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
        <g className={mobile ? 'bd-ring m' : 'bd-ring'} opacity={mobile ? torus * 0.6 : torus}>
          <g filter={`url(#${id('torus')})`} className="bd-torus">
            <g transform={r.transform}>
              <ellipse cx={r.cx} cy={r.cy} rx={r.rx} ry={r.ry} fill="none" stroke={`url(#${id('torus-g')})`} strokeWidth={r.w} />
              <ellipse cx={r.cx} cy={r.cy} rx={r.rx} ry={r.ry} fill="none" stroke={`url(#${id('torus-g2')})`} strokeWidth={r.w} opacity="0">
                {live && <animate attributeName="opacity" values="0;0.75;0" dur="22s" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1" repeatCount="indefinite" />}
              </ellipse>
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
