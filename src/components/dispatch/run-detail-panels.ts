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
