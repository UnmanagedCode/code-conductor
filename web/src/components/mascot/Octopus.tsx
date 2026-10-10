import { cn } from '@/lib/utils';

export type OctopusMood = 'happy' | 'sleepy' | 'conducting' | 'curious';

type Props = {
  mood?: OctopusMood;
  className?: string;
  title?: string;
};

const BODY = 'var(--mascot-body)';
const SHADE = 'var(--mascot-shade)';
const BELLY = 'var(--mascot-belly)';
const COAT = 'var(--mascot-coat)';
const INK = 'var(--mascot-ink)';
const BATON = 'var(--mascot-baton)';

function Eyes({ mood, cx = [49, 71], cy = 48 }: { mood: OctopusMood; cx?: [number, number]; cy?: number }) {
  if (mood === 'sleepy') {
    return (
      <g stroke={INK} strokeWidth={2.6} strokeLinecap="round" fill="none">
        {cx.map((x) => (
          <path key={x} d={`M${x - 6} ${cy + 1} Q${x} ${cy + 6} ${x + 6} ${cy + 1}`} />
        ))}
      </g>
    );
  }
  const look = mood === 'curious' ? 2 : mood === 'conducting' ? 1.5 : 0.8;
  return (
    <g>
      {cx.map((x) => (
        <g key={x}>
          <ellipse cx={x} cy={cy} rx={7.5} ry={8.5} fill="#fff" />
          <circle cx={x + look} cy={cy + 1.5} r={4.4} fill={INK} />
          <circle cx={x + look + 1.6} cy={cy - 0.6} r={1.5} fill="#fff" />
        </g>
      ))}
    </g>
  );
}

/** Full character: an octopus in a bow tie, conducting with one arm. */
export function OctopusMaestro({ mood = 'happy', className, title = 'Code Conductor mascot' }: Props) {
  const conducting = mood === 'conducting';
  return (
    <svg viewBox="0 0 120 120" className={cn('overflow-visible', className)} role="img" aria-label={title}>
      <g className={cn(mood !== 'sleepy' && 'animate-sway')} style={{ transformOrigin: '60px 100px', transformBox: 'view-box' }}>
        {/* back tentacles */}
        <g stroke={SHADE} strokeWidth={9} strokeLinecap="round" fill="none">
          <path d="M50 74 C 46 88, 42 98, 48 106" />
          <path d="M70 74 C 74 88, 78 98, 72 106" />
        </g>
        {/* front tentacles */}
        <g stroke={BODY} strokeWidth={9.5} strokeLinecap="round" fill="none">
          <path d="M40 70 C 30 82, 22 92, 28 102 C 32 108, 41 105, 37 98" />
          <path d="M58 77 C 58 90, 55 100, 61 108" />
          <path d="M80 70 C 88 82, 95 92, 90 101 C 86 107, 78 104, 81 98" />
          {/* left flourish arm */}
          <path d="M34 62 C 24 60, 17 52, 17 45 C 17 40, 22 38, 25 41" />
        </g>
        {/* suckers */}
        <g fill={BELLY} opacity={0.75}>
          <circle cx={29} cy={95} r={1.6} />
          <circle cx={33} cy={88} r={1.6} />
          <circle cx={91} cy={93} r={1.6} />
          <circle cx={87} cy={86} r={1.6} />
          <circle cx={57.5} cy={95} r={1.6} />
        </g>

        {/* head */}
        <path d="M27 49 C 27 25, 43 13, 60 13 C 77 13, 93 25, 93 49 C 93 66, 80 76, 60 76 C 40 76, 27 66, 27 49 Z" fill={BODY} />
        <path d="M33 40 C 36 26, 46 19, 58 18" stroke="#fff" strokeOpacity={0.35} strokeWidth={4} strokeLinecap="round" fill="none" />
        <g fill={BELLY} opacity={0.55}>
          <circle cx={72} cy={24} r={3} />
          <circle cx={80} cy={31} r={2} />
          <circle cx={64} cy={20} r={1.6} />
        </g>
        <Eyes mood={mood} />
        <ellipse cx={39} cy={59} rx={4.5} ry={2.6} fill="#ff7a8a" opacity={0.45} />
        <ellipse cx={81} cy={59} rx={4.5} ry={2.6} fill="#ff7a8a" opacity={0.45} />
        {mood === 'sleepy' ? (
          <circle cx={60} cy={62} r={2.2} fill={INK} opacity={0.8} />
        ) : (
          <path d="M53.5 60 Q60 66.5 66.5 60" stroke={INK} strokeWidth={2.6} strokeLinecap="round" fill="none" />
        )}

        {/* bow tie */}
        <g fill={COAT}>
          <path d="M60 78 L48.5 71.5 Q46.5 78 48.5 84.5 Z" />
          <path d="M60 78 L71.5 71.5 Q73.5 78 71.5 84.5 Z" />
          <circle cx={60} cy={78} r={3.4} />
        </g>

        {/* baton arm */}
        <g
          className={cn(conducting && 'animate-baton')}
          style={{ transformOrigin: '84px 66px', transformBox: 'view-box' }}
        >
          <path d="M84 66 C 94 63, 100 54, 101 44" stroke={BODY} strokeWidth={9.5} strokeLinecap="round" fill="none" />
          <line x1={101} y1={42} x2={111} y2={14} stroke={BATON} strokeWidth={2.6} strokeLinecap="round" />
          <circle cx={101.5} cy={42.5} r={3.6} fill={BELLY} />
          <circle cx={111} cy={14} r={1.8} fill="#fff" stroke={BATON} strokeWidth={1} />
        </g>

        {mood === 'sleepy' && (
          <g fill="var(--muted-foreground)" fontFamily="var(--font-sans)" fontWeight={700}>
            <text x={96} y={24} fontSize={11}>z</text>
            <text x={104} y={14} fontSize={8}>z</text>
          </g>
        )}
        {conducting && (
          <g fill="var(--primary)" opacity={0.85}>
            <path d="M14 22 v-9 l7 -2 v9" stroke="var(--primary)" strokeWidth={1.6} fill="none" />
            <circle cx={12} cy={22} r={2.6} />
            <circle cx={19} cy={20} r={2.6} />
          </g>
        )}
      </g>
    </svg>
  );
}

/** Single-colour mark for the logo lockup and favicon; inherits currentColor. */
export function OctopusMark({ className, title = 'Code Conductor' }: Omit<Props, 'mood'>) {
  return (
    <svg viewBox="0 0 48 48" className={className} role="img" aria-label={title}>
      <g fill="none" stroke="currentColor" strokeWidth={4.2} strokeLinecap="round">
        <path d="M15 29 C 12 35, 9 38, 11 43" />
        <path d="M24 31 C 24 36, 23 39, 25 43" />
        <path d="M33 29 C 36 35, 39 38, 37 43" />
        <path d="M35 24 C 39 22, 41 18, 42 14" />
      </g>
      <line x1={42} y1={13} x2={46} y2={3} stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
      <path d="M9 21 C 9 11, 15.5 5, 24 5 C 32.5 5, 39 11, 39 21 C 39 28, 33 32, 24 32 C 15 32, 9 28, 9 21 Z" fill="currentColor" />
      <circle cx={19} cy={20} r={3.1} fill="var(--background)" />
      <circle cx={29} cy={20} r={3.1} fill="var(--background)" />
    </svg>
  );
}

/** Head only, for small avatars where the full character turns to noise. */
export function OctopusHead({ mood = 'happy', className, title = 'Code Conductor' }: Props) {
  return (
    <svg viewBox="22 8 76 76" className={className} role="img" aria-label={title}>
      <path d="M27 49 C 27 25, 43 13, 60 13 C 77 13, 93 25, 93 49 C 93 66, 80 76, 60 76 C 40 76, 27 66, 27 49 Z" fill={BODY} />
      <path d="M33 40 C 36 26, 46 19, 58 18" stroke="#fff" strokeOpacity={0.35} strokeWidth={4} strokeLinecap="round" fill="none" />
      <Eyes mood={mood} />
      <path d="M53.5 60 Q60 66.5 66.5 60" stroke={INK} strokeWidth={2.8} strokeLinecap="round" fill="none" />
    </svg>
  );
}

/** Rounded-square app icon (PWA icon, empty states). */
export function OctopusBadge({ mood = 'happy', className, title = 'Code Conductor' }: Props) {
  return (
    <svg viewBox="0 0 120 120" className={className} role="img" aria-label={title}>
      <defs>
        <linearGradient id="cc-badge-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="oklch(0.32 0.03 260)" />
          <stop offset="1" stopColor="oklch(0.2 0.02 260)" />
        </linearGradient>
      </defs>
      <rect x={4} y={4} width={112} height={112} rx={28} fill="url(#cc-badge-bg)" />
      <g transform="translate(8 14) scale(0.87)">
        <g stroke={BODY} strokeWidth={10} strokeLinecap="round" fill="none">
          <path d="M42 70 C 34 84, 30 94, 38 104" />
          <path d="M60 76 C 60 90, 58 100, 62 108" />
          <path d="M78 70 C 86 84, 90 94, 82 104" />
        </g>
        <path d="M27 49 C 27 25, 43 13, 60 13 C 77 13, 93 25, 93 49 C 93 66, 80 76, 60 76 C 40 76, 27 66, 27 49 Z" fill={BODY} />
        <path d="M33 40 C 36 26, 46 19, 58 18" stroke="#fff" strokeOpacity={0.35} strokeWidth={4} strokeLinecap="round" fill="none" />
        <Eyes mood={mood} />
        <path d="M53.5 60 Q60 66.5 66.5 60" stroke={INK} strokeWidth={2.8} strokeLinecap="round" fill="none" />
        <g fill="#f4f1ec">
          <path d="M60 79 L48.5 72.5 Q46.5 79 48.5 85.5 Z" />
          <path d="M60 79 L71.5 72.5 Q73.5 79 71.5 85.5 Z" />
          <circle cx={60} cy={79} r={3.4} />
        </g>
        <path d="M86 64 C 96 60, 101 52, 102 44" stroke={BODY} strokeWidth={10} strokeLinecap="round" fill="none" />
        <line x1={102} y1={42} x2={112} y2={14} stroke="#f4f1ec" strokeWidth={3} strokeLinecap="round" />
      </g>
    </svg>
  );
}
