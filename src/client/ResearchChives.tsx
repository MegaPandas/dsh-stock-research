import type { CSSProperties } from "react";

const CUT_STAGGER_SECONDS = 0.12;
const plants = [
  { x: 84, scale: 0.86, direction: 1, bundleAngle: -88, extra: true },
  { x: 140, scale: 0.94, direction: -1, bundleAngle: -93, extra: true },
  { x: 196, scale: 0.84, direction: -1, bundleAngle: -88, extra: false },
  { x: 252, scale: 1, direction: 1, bundleAngle: -94, extra: false },
  { x: 308, scale: 0.9, direction: -1, bundleAngle: -83, extra: false },
  { x: 364, scale: 0.85, direction: 1, bundleAngle: -87, extra: true },
  { x: 420, scale: 0.96, direction: -1, bundleAngle: -91, extra: true },
];

const leaves = [
  {
    root: -3,
    tone: "dark",
    path: "M-4 1C-11-24-24-48-24-65L-22-67C-21-47-9-23-2 1Z",
  },
  {
    root: -1,
    tone: "dark",
    path: "M-2 1C-6-22-12-52-8-77L-7-78C-9-53-3-21 0 1Z",
  },
  { root: 2, tone: "dark", path: "M1 1C0-27 3-54 10-75L12-76C6-53 3-25 3 1Z" },
  {
    root: 5,
    tone: "dark",
    path: "M4 1C9-22 17-47 29-63L30-62C20-43 12-20 6 1Z",
  },
  {
    root: -5,
    tone: "base",
    path: "M-6 1C-12-22-20-43-33-49Q-37-49-37-45Q-39-51-34-51C-17-47-10-22-4 1Z",
  },
  {
    root: 7,
    tone: "base",
    path: "M6 1C14-20 28-40 35-36Q38-33 36-29Q37-36 33-36C26-35 14-15 8 1Z",
  },
  {
    root: -3,
    tone: "base",
    path: "M-4 1C-7-25-6-48-2-67L0-69C-3-46-4-23-2 1Z",
  },
  { root: 1, tone: "base", path: "M0 1C-1-30-3-55-2-81L0-82C-1-55 2-28 2 1Z" },
  { root: 4, tone: "base", path: "M3 1C7-26 8-52 7-68L9-70C11-51 9-24 5 1Z" },
  {
    root: 3,
    tone: "base",
    path: "M2 1C6-20 17-40 18-56L20-58C20-38 9-18 4 1Z",
  },
  {
    root: 0,
    tone: "light",
    path: "M-1 1C-2-24-12-46-17-56Q-21-63-20-67Q-17-61-15-57C-7-44 0-22 1 1Z",
  },
  {
    root: 6,
    tone: "light",
    path: "M5 1C13-21 22-51 23-70L25-71C25-49 16-19 7 1Z",
  },
  {
    root: -4,
    tone: "light",
    path: "M-5 1C-6-20-16-37-13-46L-11-48C-14-37-3-17-3 1Z",
  },
  {
    root: 0,
    tone: "light",
    path: "M-1 1C3-15 12-34 11-44L13-46C15-35 6-13 1 1Z",
  },
];

function Leaves() {
  return leaves.map(({ tone, path }) => (
    <path key={path} className={`sr-chives-leaf-${tone}`} d={path} />
  ));
}

function RootedLeaves({ delay }: { delay: number }) {
  return (
    <g
      className="sr-chives-plant"
      style={{ "--sr-growth-delay": `${delay}s` } as CSSProperties}
    >
      {leaves.map(({ root, tone, path }) => (
        <g
          key={path}
          className={`sr-chives-leaf-${tone}`}
          transform={`translate(${root} 0)`}
        >
          <path className="sr-chives-stubble" d="M-1 0H1L.7 10H-.7Z" />
          <g className="sr-chives-shoot">
            <path d={path} transform={`translate(${-root} 0)`} />
          </g>
        </g>
      ))}
    </g>
  );
}

export function ResearchChives({ growing }: { growing: boolean }) {
  return (
    <svg
      className="sr-research-chives"
      data-growing={growing}
      viewBox="0 0 504 108"
      preserveAspectRatio="xMidYMid slice"
      width="504"
      height="108"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <g className="sr-chives-ground-compact">
        <ellipse className="sr-chives-soil" cx="252" cy="94" rx="91" ry="5" />
        <path className="sr-chives-ground" d="M154 92H350" />
      </g>
      <g data-extra="true">
        <ellipse className="sr-chives-soil" cx="252" cy="94" rx="220" ry="5" />
        <path className="sr-chives-ground" d="M30 92H474" />
      </g>
      {plants.map(({ x, scale, direction, extra }, index) => (
        <g key={x} data-extra={extra} transform={`translate(${x} 83)`}>
          <g transform={`scale(${scale * direction} ${scale})`}>
            <RootedLeaves delay={index * CUT_STAGGER_SECONDS} />
          </g>
        </g>
      ))}
      {plants.map(({ x, scale, direction, bundleAngle, extra }, index) => (
        <g
          key={x}
          className="sr-chives-clipping"
          data-extra={extra}
          style={
            {
              animationDelay: `${index * CUT_STAGGER_SECONDS}s`,
              "--sr-cut-start": `${x}px`,
              "--sr-plant-scale": scale,
              "--sr-bundle-x": `${x + 20}px`,
              "--sr-bundle-angle": `${bundleAngle}deg`,
            } as CSSProperties
          }
        >
          <g transform={`scale(${direction} 1)`}>
            <Leaves />
            <path
              className="sr-chives-cut-ends"
              d="M-5 0-5 5M-3 0-3 6M-1 0-1 5M1 0 1 6M3 0 3 5M5 0 5 4"
            />
          </g>
        </g>
      ))}
      <g className="sr-chives-slash">
        <path
          className="sr-chives-slash-trail"
          pathLength="1"
          d="M36 91Q252 71 471 80"
        />
        <path
          className="sr-chives-slash-edge"
          pathLength="1"
          d="M30 85Q252 65 474 77"
        />
        <path
          className="sr-chives-slash-light"
          pathLength="1"
          d="M30 85Q252 65 474 77"
        />
      </g>
    </svg>
  );
}
