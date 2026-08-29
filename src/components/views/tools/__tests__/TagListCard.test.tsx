/**
 * Regression cover for the Epics / Labels cards in Settings → Issues.
 *
 * Both were add-only: `issueStore` exposed `addEpic` / `addLabel` and nothing
 * else, and `TagListCard` rendered each tag as a bare `<span>`. A typo could be
 * created and never taken back. Removal is destructive beyond the chip itself
 * (the store detaches the tag from every issue carrying it), so it goes through
 * the sanctioned `ConfirmDeleteModal` rather than firing on click.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TagListCard } from "@/components/views/tools/TagListCard";

function renderCard(overrides: Partial<React.ComponentProps<typeof TagListCard>> = {}) {
  const onAdd = vi.fn();
  const onRemove = vi.fn();
  render(
    <TagListCard
      title="Labels"
      items={["bug", "api"]}
      onAdd={onAdd}
      onRemove={onRemove}
      entityLabel="label"
      tagClassName="bg-bg-elevated text-text-muted"
      placeholder="New label..."
      {...overrides}
    />,
  );
  return { onAdd, onRemove };
}

describe("TagListCard removal", () => {
  it("gives every tag a remove control", () => {
    renderCard();

    expect(screen.getByLabelText("Remove label bug")).toBeInTheDocument();
    expect(screen.getByLabelText("Remove label api")).toBeInTheDocument();
  });

  it("does not remove on the first click — it asks first", () => {
    const { onRemove } = renderCard();

    fireEvent.click(screen.getByLabelText("Remove label bug"));

    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByText("Remove label?")).toBeInTheDocument();
    expect(screen.getByText("“bug”")).toBeInTheDocument();
  });

  it("removes only after the confirm button", () => {
    const { onRemove } = renderCard();

    fireEvent.click(screen.getByLabelText("Remove label bug"));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(onRemove).toHaveBeenCalledWith("bug");
  });

  it("cancelling leaves the tag alone", () => {
    const { onRemove } = renderCard();

    fireEvent.click(screen.getByLabelText("Remove label bug"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.queryByText("Remove label?")).not.toBeInTheDocument();
  });

  it("discloses live usage in the confirm callout", () => {
    renderCard({ removeWarnings: () => ["3 issues have this label — it is removed from them too."] });

    fireEvent.click(screen.getByLabelText("Remove label bug"));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "3 issues have this label — it is removed from them too.",
    );
  });

  it("stays add-only when no onRemove is supplied", () => {
    render(
      <TagListCard
        title="Labels"
        items={["bug"]}
        onAdd={vi.fn()}
        tagClassName=""
        placeholder="New label..."
      />,
    );

    expect(screen.queryByLabelText(/^Remove /)).not.toBeInTheDocument();
  });

  it("still adds", () => {
    const { onAdd } = renderCard();

    fireEvent.change(screen.getByPlaceholderText("New label..."), {
      target: { value: "  security  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onAdd).toHaveBeenCalledWith("security");
  });
});
