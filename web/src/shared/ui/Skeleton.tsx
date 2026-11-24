/** Placeholder layout shown while the session and servers load, instead of an empty screen. */
const BUBBLES = ['46%', '30%', '58%', '38%', '52%', '28%', '44%'];
const ROWS = [62, 48, 70, 54];

export function AppSkeleton({ mobile }: { mobile: boolean }) {
  if (mobile) {
    return (
      <div className="skel-app skel-mobile" aria-busy="true" aria-label="Loading">
        <div className="skel-head">
          <span className="skel skel-title" />
        </div>
        <div className="skel-row-list">
          <div className="skel-rail">
            {[0, 1, 2].map((i) => (
              <span key={i} className="skel skel-circle" />
            ))}
          </div>
          <div className="skel-panel">
            {ROWS.map((w, i) => (
              <span key={i} className="skel skel-line" style={{ width: `${w}%` }} />
            ))}
          </div>
        </div>
        <div className="skel skel-tabbar" />
      </div>
    );
  }
  return (
    <div className="skel-app skel-desktop" aria-busy="true" aria-label="Loading">
      <div className="skel-rail">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="skel skel-circle" />
        ))}
      </div>
      <div className="skel-panel">
        <span className="skel skel-line" style={{ width: '70%', height: 20 }} />
        {ROWS.map((w, i) => (
          <span key={i} className="skel skel-line" style={{ width: `${w}%` }} />
        ))}
      </div>
      <div className="skel-main">
        {BUBBLES.map((w, i) => (
          <span key={i} className={'skel skel-msg' + (i % 3 === 2 ? ' mine' : '')} style={{ width: w }} />
        ))}
        <span className="skel skel-composer" />
      </div>
    </div>
  );
}
