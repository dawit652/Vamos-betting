import { barcodeLayout } from '@/lib/tickets';

/**
 * Code 128 as inline SVG: one rect per bar, no extra service. The text sits under the bars so a
 * cashier can type it when a scanner cannot read it.
 */
export function Barcode({ text, moduleWidth = 2 }: { text: string; moduleWidth?: number }) {
  const { width, rects } = barcodeLayout(text, moduleWidth);
  return (
    <div className="barcode" data-testid="ticket-barcode" data-code={text}>
      <svg
        role="img"
        aria-label={`Barcode ${text}`}
        viewBox={`0 0 ${width} 40`}
        width="100%"
        height="40"
        preserveAspectRatio="none"
        shapeRendering="crispEdges"
      >
        <rect x="0" y="0" width={width} height="40" fill="#fff" />
        {rects.map((rect) => (
          <rect key={rect.x} x={rect.x} y="0" width={rect.width} height="40" fill="#000" />
        ))}
      </svg>
      <div className="barcode-text">{text}</div>
    </div>
  );
}
