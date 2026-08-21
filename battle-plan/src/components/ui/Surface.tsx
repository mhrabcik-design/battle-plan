import type { ComponentPropsWithoutRef, ElementType, ReactNode } from 'react';

type SurfaceTone = 'neutral' | 'task' | 'meeting' | 'completed' | 'danger';

const toneClasses: Record<SurfaceTone, string> = {
  neutral: 'before:bg-slate-500',
  task: 'before:bg-indigo-500',
  meeting: 'before:bg-orange-500',
  completed: 'before:bg-emerald-500',
  danger: 'before:bg-red-500',
};

type SurfaceProps<T extends ElementType> = {
  as?: T;
  children: ReactNode;
  tone?: SurfaceTone;
  className?: string;
} & Omit<ComponentPropsWithoutRef<T>, 'as' | 'children' | 'className'>;

export function Surface<T extends ElementType = 'div'>({
  as,
  children,
  tone = 'neutral',
  className = '',
  ...props
}: SurfaceProps<T>) {
  const Component = as ?? 'div';
  return (
    <Component
      className={`office-card relative isolate min-w-0 overflow-clip before:absolute before:inset-y-4 before:left-0 before:w-[3px] before:rounded-r-full ${toneClasses[tone]} ${className}`}
      {...props}
    >
      {children}
    </Component>
  );
}
