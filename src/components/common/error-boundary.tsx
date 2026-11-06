import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/common/input/button.tsx";

type Props = { children: React.ReactNode };
type State = { error: Error | null };

/**
 * Keeps a render crash inside one screen instead of blanking the whole POS.
 * Without it any throw during commit (a bad toast payload, a null field in a
 * shared component) unmounts `#root` and leaves a white page until reload.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("UI crashed:", error, info.componentStack);
  }

  render() {
    return this.state.error ? <ErrorFallback error={this.state.error} /> : this.props.children;
  }
}

function ErrorFallback({ error }: { error: Error }) {
  const { t } = useTranslation("common");

  return (
    <div className="flex flex-col items-center justify-center gap-4 h-full p-6 text-center">
      <h2 className="text-2xl font-semibold">{t("actions.error")}</h2>
      <p className="text-sm opacity-70 max-w-[60ch] break-words">{error.message}</p>
      <Button variant="primary" onClick={() => window.location.reload()}>
        {t("actions.retry")}
      </Button>
    </div>
  );
}

export default ErrorBoundary;
