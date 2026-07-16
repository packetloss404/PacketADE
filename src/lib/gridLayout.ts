export interface GridCell {
  row: number;
  col: number;
  agentIndex: number | null;
}

export interface GridLayout {
  rows: number;
  cols: number;
  cells: GridCell[];
}

/**
 * Compute a symmetric grid layout for N agents.
 * Produces the most square-like grid that fits all items.
 *
 * Results: 1→1x1, 2→1x2, 3→2x2, 4→2x2, 5→2x3, 6→2x3
 */
export function computeGridLayout(agentCount: number): GridLayout {
  if (agentCount <= 0) {
    return { rows: 0, cols: 0, cells: [] };
  }

  const cols = Math.ceil(Math.sqrt(agentCount));
  const rows = Math.ceil(agentCount / cols);

  const cells: GridCell[] = [];
  let agentIdx = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        row: r,
        col: c,
        agentIndex: agentIdx < agentCount ? agentIdx++ : null,
      });
    }
  }

  return { rows, cols, cells };
}
