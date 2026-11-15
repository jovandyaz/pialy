import { useMemo } from 'react';
import { encode } from 'uqr';
import { cn } from '../lib/cn';

const QUIET_ZONE_MODULES = 2;

/** Renders `value` as an SVG QR code; modules are paths, so no `innerHTML` and no image request. */
export function QrCode({ value, label, className }: { readonly value: string; readonly label: string; readonly className?: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(value, { ecc: 'M', border: 0 });
    const parts: string[] = [];
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) parts.push(`M${x + QUIET_ZONE_MODULES} ${y + QUIET_ZONE_MODULES}h1v1h-1z`);
      }),
    );
    return { size: qr.size + QUIET_ZONE_MODULES * 2, path: parts.join('') };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={cn('block bg-paper text-ink', className)}
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}
