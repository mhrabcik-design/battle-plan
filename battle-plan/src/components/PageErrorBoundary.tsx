import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface PageErrorBoundaryProps {
  children: ReactNode;
  resetKey: string;
}

interface PageErrorBoundaryState {
  hasError: boolean;
}

export class PageErrorBoundary extends Component<PageErrorBoundaryProps, PageErrorBoundaryState> {
  state: PageErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): PageErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Nepodařilo se načíst obrazovku.', error, info.componentStack);
  }

  componentDidUpdate(previousProps: PageErrorBoundaryProps) {
    if (this.state.hasError && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 rounded-3xl border border-amber-500/20 bg-slate-900/60 p-10 text-center shadow-2xl">
        <AlertTriangle className="h-10 w-10 text-amber-400" />
        <div>
          <h2 className="text-lg font-black text-white">Obrazovku se nepodařilo načíst</h2>
          <p className="mt-2 text-sm text-slate-400">
            Obnov aplikaci a zkus to znovu. Rozpracovaná data uložená v zařízení zůstanou zachovaná.
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-xs font-black uppercase tracking-widest text-white transition-colors hover:bg-indigo-500"
        >
          <RefreshCw className="h-4 w-4" />
          Obnovit aplikaci
        </button>
      </div>
    );
  }
}
