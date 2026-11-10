/** Report numbers appear only after a successful week read. A cached error is still a failure. */
export function driverTimeReportPanels(state: {
  isError: boolean;
  isLoading: boolean;
  isFetching?: boolean;
  hasData: boolean;
}) {
  const showReport = state.hasData && !state.isError;
  const showLoading = !showReport && (state.isLoading || !!state.isFetching);
  return {
    showError: state.isError,
    showLoading,
    showUnavailable: !showReport && !showLoading,
    showReport,
    showKpiNumbers: showReport,
    allowExport: showReport,
  };
}
