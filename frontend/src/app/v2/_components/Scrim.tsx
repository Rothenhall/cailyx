'use client';

/**
 * Scrim — /v2. The one dimming layer the console uses. Previously the Flywheel
 * and the Context drawer each carried their own, at different opacities and
 * different z-indexes, and because both were `absolute inset-0` inside <main>
 * neither covered the top bar — entering focus mode dimmed the canvas while the
 * header stayed perfectly crisp above it.
 *
 * This one is `fixed`, so the whole console recedes together.
 *
 * @module app/v2/_components/Scrim
 */

export function Scrim({
  open,
  onClose,
  z = 30,
}: {
  open: boolean;
  onClose: () => void;
  /** stacking layer — the drawer sits below the wheel's focus mode */
  z?: number;
}) {
  return (
    <div
      aria-hidden
      onPointerDown={onClose}
      style={{ zIndex: z }}
      className={`fixed inset-0 bg-[rgba(26,23,18,0.14)] backdrop-blur-md transition-opacity duration-panel ease-brand ${
        open ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
    />
  );
}
