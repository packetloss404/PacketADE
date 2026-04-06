import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StatusStrip } from "../flight-deck/StatusStrip";
import type { FlightStatus } from "@/types/flight";

function makeStatusCounts(overrides: Partial<Record<FlightStatus, number>> = {}): Record<FlightStatus, number> {
  return {
    draft: 0,
    planning: 0,
    ready: 0,
    active: 0,
    paused: 0,
    review: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    ...overrides,
  };
}

describe("StatusStrip", () => {
  it("renders total flight count text", () => {
    render(<StatusStrip statusCounts={makeStatusCounts({ active: 2, done: 1 })} total={3} />);
    expect(screen.getByText("3 flights")).toBeInTheDocument();
  });

  it("renders singular 'flight' when total is 1", () => {
    render(<StatusStrip statusCounts={makeStatusCounts({ active: 1 })} total={1} />);
    expect(screen.getByText("1 flight")).toBeInTheDocument();
  });

  it("renders status badges for non-zero counts", () => {
    render(<StatusStrip statusCounts={makeStatusCounts({ active: 2, review: 1 })} total={3} />);
    expect(screen.getByText(/Active/)).toBeInTheDocument();
    expect(screen.getByText(/Review/)).toBeInTheDocument();
  });

  it("hides badges for zero-count statuses", () => {
    render(<StatusStrip statusCounts={makeStatusCounts({ active: 1 })} total={1} />);
    expect(screen.queryByText(/Paused/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Failed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Done/)).not.toBeInTheDocument();
  });

  it("shows New Flight button when onNewFlight is provided", () => {
    const handler = vi.fn();
    render(<StatusStrip statusCounts={makeStatusCounts()} total={0} onNewFlight={handler} />);
    const btn = screen.getByText("New Flight");
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("hides New Flight button when onNewFlight is undefined", () => {
    render(<StatusStrip statusCounts={makeStatusCounts()} total={0} />);
    expect(screen.queryByText("New Flight")).not.toBeInTheDocument();
  });
});
