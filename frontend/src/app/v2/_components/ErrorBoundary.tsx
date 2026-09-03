'use client';

/**
 * ErrorBoundary — /v2. Wraps the canvas so one card throwing on a malformed
 * payload degrades to a recoverable panel instead of blanking the whole
 * console. React only catches render/lifecycle errors this way, so it stays a
 * class component.
 *
 * @module app/v2/_components/ErrorBoundary
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** what failed, in the operator's language — e.g. "the agents panel" */
  label: string;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // keep the stack reachable in dev without crashing the console
    console.error(`[v2] ${this.props.label} failed to render`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid h-full w-full place-items-center p-4">
        <div className="max-w-[280px] rounded-r3 border border-border bg-bg-raised/90 p-4 text-center shadow-e2">
          <p className="text-ui font-semibold text-text">{this.props.label} stopped</p>
          <p className="mt-1 text-caption leading-relaxed text-faint">
            {error.message || 'An unexpected error occurred.'}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-3 rounded-r2 border border-accent-dim bg-accent-dim/15 px-3 py-1.5 text-caption font-medium text-accent transition-colors duration-micro hover:bg-accent-dim/25"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
