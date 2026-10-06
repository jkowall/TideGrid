import { Component, type ErrorInfo, type ReactNode } from "react";

export interface ErrorBoundaryProps {
  /** The designed failure screen shown in place of the page. */
  fallback: ReactNode;
  children: ReactNode;
}

/**
 * Catches an error thrown while rendering, so a bug or unreadable data shows
 * the app's own failure screen instead of a blank page. React logs the error
 * itself; nothing here reaches a server.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(_error: unknown, _info: ErrorInfo) {
    // The fallback is the whole response; React has already reported the error.
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
