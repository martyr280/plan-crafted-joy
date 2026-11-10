export function dispatchRunPanels(state: {
  isError: boolean;
  isLoading: boolean;
  hasData: boolean;
}) {
  const showError = state.isError;
  const showRun = state.hasData && !state.isError;
  return {
    showError,
    showStaleNote: state.isError && state.hasData,
    showLoading: state.isLoading && !state.hasData,
    showRun,
    allowSendOrPrint: showRun,
  };
}

/** Runs-list failure. Zero KPIs and leftover rows are not a successful empty board. */
export function dispatchListPanels(state: {
  isError: boolean;
  isLoading: boolean;
  hasData: boolean;
}) {
  const showError = state.isError;
  const showRows = state.hasData && !state.isError;
  return {
    showError,
    showStaleNote: state.isError && state.hasData,
    showLoading: state.isLoading && !state.hasData,
    showRows,
    showKpiNumbers: showRows,
    allowRowActions: showRows,
  };
}
