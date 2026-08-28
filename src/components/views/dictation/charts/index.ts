/**
 * Chart primitives for the dictation analytics panel.
 *
 * Components and their prop types only. The scale/shape maths (`./scale`) and
 * the theme-token vocabulary (`./tokens`) are imported directly from their own
 * modules — keeping value exports out of this barrel is what stops
 * `react-refresh/only-export-components` firing on it.
 *
 * Decision record and the primitive-to-visualisation mapping:
 * `dev/dictation-analytics-charting.md`.
 */

export { ChartFrame } from "./ChartFrame";
export { TimeSeriesChart } from "./TimeSeriesChart";
export { HeatmapGrid } from "./HeatmapGrid";
export { BarSeries } from "./BarSeries";

export type { ChartFrameProps, ChartTableColumn } from "./ChartFrame";
export type { TimeSeriesChartProps, TimeSeriesPoint } from "./TimeSeriesChart";
export type { HeatmapGridProps } from "./HeatmapGrid";
export type { BarSeriesProps, BarDatum } from "./BarSeries";
export type { ChartTone } from "./tokens";
export type { Curve, LinearScale, BandScale, Point } from "./scale";
