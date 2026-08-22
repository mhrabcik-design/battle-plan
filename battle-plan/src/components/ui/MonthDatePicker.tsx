import { useMemo, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { OverlaySurface } from './OverlaySurface';
import {
  buildMonthCalendar,
  formatDateValue,
  getCalendarMonthStart,
  shiftCalendarMonth,
  toLocalIsoDate,
} from '../../utils/monthCalendar';

const WEEKDAYS = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];

type MonthDatePickerProps = {
  value: string;
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  allowClear?: boolean;
  className?: string;
};

export function MonthDatePicker({
  value,
  onChange,
  label,
  disabled = false,
  allowClear = false,
  className = '',
}: MonthDatePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => getCalendarMonthStart(value));
  const [today, setToday] = useState(() => new Date());
  const displayValue = useMemo(() => formatDateValue(value), [value]);
  const days = useMemo(
    () => isOpen ? buildMonthCalendar(visibleMonth, value, today) : [],
    [isOpen, today, value, visibleMonth],
  );

  const selectDate = (nextValue: string) => {
    onChange(nextValue);
    setIsOpen(false);
  };

  const openPicker = () => {
    const now = new Date();
    setToday(now);
    setVisibleMonth(getCalendarMonthStart(value, now));
    setIsOpen(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={openPicker}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        className={`flex min-h-9 min-w-0 items-center gap-2 rounded-lg border border-slate-700/70 bg-slate-950/40 px-3 py-1.5 text-left text-slate-200 transition-[background-color,border-color,color,opacity] hover:border-indigo-500/50 hover:bg-indigo-500/10 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      >
        <CalendarDays className="h-4 w-4 shrink-0 text-indigo-400" />
        <span className="min-w-0 truncate text-xs font-bold">{displayValue}</span>
      </button>

      <AnimatePresence>
        {isOpen && (
          <OverlaySurface
            title={label}
            onRequestClose={() => setIsOpen(false)}
            className="flex max-h-[calc(100dvh-2rem)] w-full max-w-sm flex-col overflow-hidden rounded-3xl border border-slate-700/80 bg-slate-950 shadow-2xl shadow-black/60"
          >
            <div className="flex shrink-0 items-start justify-between border-b border-slate-800 px-5 py-4">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-indigo-400">{label}</p>
                <p className="mt-1 text-lg font-black capitalize text-white">
                  {visibleMonth.toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric' })}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                aria-label="Zavřít kalendář"
                className="grid h-10 w-10 place-items-center rounded-xl border border-slate-800 text-slate-400 transition-colors hover:border-slate-700 hover:bg-slate-900 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 overflow-y-auto p-4 sm:p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setVisibleMonth((current) => shiftCalendarMonth(current, -1))}
                  aria-label="Předchozí měsíc"
                  className="grid h-11 w-11 place-items-center rounded-xl border border-slate-800 text-slate-300 transition-colors hover:border-indigo-500/40 hover:bg-indigo-500/10 hover:text-white"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Celý měsíc</span>
                <button
                  type="button"
                  onClick={() => setVisibleMonth((current) => shiftCalendarMonth(current, 1))}
                  aria-label="Další měsíc"
                  className="grid h-11 w-11 place-items-center rounded-xl border border-slate-800 text-slate-300 transition-colors hover:border-indigo-500/40 hover:bg-indigo-500/10 hover:text-white"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </div>

              <div className="grid grid-cols-7 gap-0.5 sm:gap-1" aria-hidden="true">
                {WEEKDAYS.map((weekday) => (
                  <span key={weekday} className="py-1 text-center text-[10px] font-black uppercase tracking-wider text-slate-600">
                    {weekday}
                  </span>
                ))}
              </div>

              <div className="mt-1 grid grid-cols-7 gap-0.5 sm:gap-1" role="grid" aria-label={label}>
                {days.map((day) => (
                  <button
                    key={day.isoDate}
                    type="button"
                    onClick={() => selectDate(day.isoDate)}
                    aria-label={formatDateValue(day.isoDate)}
                    aria-selected={day.isSelected}
                    autoFocus={day.isSelected || (!value && day.isToday)}
                    className={`relative grid aspect-square min-h-10 place-items-center rounded-xl text-sm font-bold transition-[background-color,color,box-shadow,transform] hover:scale-[1.04] hover:bg-indigo-500/20 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                      day.isSelected
                        ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-950/50'
                        : day.isCurrentMonth
                          ? 'text-slate-300'
                          : 'text-slate-700'
                    }`}
                  >
                    {day.dayNumber}
                    {day.isToday && !day.isSelected && (
                      <span className="absolute bottom-1 h-1 w-1 rounded-full bg-indigo-400" />
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-800 bg-slate-900/40 px-5 py-4">
              {allowClear ? (
                <button
                  type="button"
                  onClick={() => selectDate('')}
                  disabled={!value}
                  className="min-h-10 rounded-xl px-3 text-xs font-black uppercase tracking-wider text-slate-500 transition-colors hover:bg-slate-800 hover:text-red-300 disabled:invisible"
                >
                  Vymazat
                </button>
              ) : <span />}
              <button
                type="button"
                onClick={() => selectDate(toLocalIsoDate(today))}
                className="min-h-10 rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-4 text-xs font-black uppercase tracking-wider text-indigo-300 transition-colors hover:bg-indigo-500/20 hover:text-white"
              >
                Dnes
              </button>
            </div>
          </OverlaySurface>
        )}
      </AnimatePresence>
    </>
  );
}
