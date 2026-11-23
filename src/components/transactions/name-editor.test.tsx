import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NameEditor } from "./name-editor";

// protects=you can give a transaction your own name; fails_when=the saved name is untrimmed,
// an unchanged name is saved again, or clearing the field does not reset to the bank's name
describe("NameEditor", () => {
  it("saves the trimmed new name", async () => {
    const onSave = vi.fn();
    render(<NameEditor name="Alessio Peschiera" onSave={onSave} saving={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Rename Alessio Peschiera" }));
    const input = screen.getByRole("textbox", { name: "Name" });
    await userEvent.clear(input);
    await userEvent.type(input, "  Spotify ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith("Spotify", false);
  });

  it("does not save an unchanged name", async () => {
    const onSave = vi.fn();
    render(<NameEditor name="Spotify" onSave={onSave} saving={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Rename Spotify" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("an empty name asks to reset to the bank's name", async () => {
    const onSave = vi.fn();
    render(<NameEditor name="Spotify" onSave={onSave} saving={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Rename Spotify" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "Name" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(null, false);
  });

  // protects=renaming one charge without renaming the others; fails_when=the choice is lost or always "all"
  it("scoped: renames all like this by default, or only this one when picked", async () => {
    const onSave = vi.fn();
    render(<NameEditor name="iCloud" onSave={onSave} saving={false} scoped />);
    const rename = async (next: string, pick?: string) => {
      await userEvent.click(screen.getByRole("button", { name: "Rename iCloud" }));
      expect(screen.getByRole("radio", { name: "All like this" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      if (pick) await userEvent.click(screen.getByRole("radio", { name: pick }));
      const input = screen.getByRole("textbox", { name: "Name" });
      await userEvent.clear(input);
      await userEvent.type(input, next);
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
    };
    await rename("Apple Music");
    expect(onSave).toHaveBeenLastCalledWith("Apple Music", false);
    await rename("Apple TV", "Only this one");
    expect(onSave).toHaveBeenLastCalledWith("Apple TV", true);
    expect(screen.queryByText(/Others keep their name/)).not.toBeInTheDocument();
  });

  it("not scoped: no choice is shown", async () => {
    render(<NameEditor name="Dinner" onSave={vi.fn()} saving={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Rename Dinner" }));
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });
});
