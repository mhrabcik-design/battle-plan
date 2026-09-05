type OverlayPose = { opacity: number; x?: number; y?: number; scale?: number };

export function getOverlayMotion(variant: 'dialog' | 'sheet', reducedMotion: boolean) {
  const enter = { type: 'tween' as const, duration: reducedMotion ? 0.12 : 0.2, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] };
  const leave = { type: 'tween' as const, duration: reducedMotion ? 0.08 : 0.12, ease: 'easeIn' as const };
  const initial: OverlayPose = reducedMotion
    ? { opacity: 0 }
    : variant === 'sheet' ? { opacity: 0, x: 24 } : { opacity: 0, y: 12, scale: 0.985 };
  const animate: OverlayPose = reducedMotion
    ? { opacity: 1 }
    : variant === 'sheet' ? { opacity: 1, x: 0 } : { opacity: 1, y: 0, scale: 1 };
  const exit: OverlayPose = reducedMotion
    ? { opacity: 0 }
    : variant === 'sheet' ? { opacity: 0, x: 18 } : { opacity: 0, y: 8, scale: 0.99 };

  return {
    panel: { initial, animate, exit: { ...exit, transition: leave }, transition: enter },
    backdrop: {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0, transition: leave },
      transition: { ...enter, duration: reducedMotion ? 0.12 : 0.16 },
    },
  };
}
