import { describe, expect, it } from "vitest";
import { RAIL_WIDTH, backEdgeFor, railsFor, reserveFor } from "./desktopLayout";

describe("railsFor", () => {
  it("leaves the page the whole window on mobile", () => {
    expect(railsFor(false, "right", true)).toEqual({ left: 0, right: 0 });
  });

  it("keeps a rail on the floating button's edge", () => {
    expect(railsFor(true, "right", false)).toEqual({ left: 0, right: RAIL_WIDTH });
    expect(railsFor(true, "left", false)).toEqual({ left: RAIL_WIDTH, right: 0 });
  });

  it("adds the opposite rail only while the back button is on", () => {
    expect(railsFor(true, "right", true)).toEqual({ left: RAIL_WIDTH, right: RAIL_WIDTH });
  });

  it("puts the back button opposite the floating button", () => {
    expect(backEdgeFor("left")).toBe("right");
    expect(backEdgeFor("right")).toBe("left");
  });
});

describe("reserveFor", () => {
  it("measures bottom docks from the bottom edge and top docks from the top", () => {
    const reserve = reserveFor(
      [
        { side: "bottom", top: 500, bottom: 588 },
        { side: "top", top: 12, bottom: 80 },
      ],
      600,
    );
    expect(reserve).toEqual({ top: 88, bottom: 108 });
  });

  it("takes the largest of several docks on one side", () => {
    expect(
      reserveFor(
        [
          { side: "bottom", top: 540, bottom: 588 },
          { side: "bottom", top: 400, bottom: 588 },
        ],
        600,
      ),
    ).toEqual({ top: 0, bottom: 208 });
  });

  it("ignores a dock with no side", () => {
    expect(reserveFor([{ side: undefined, top: 0, bottom: 100 }], 600)).toEqual({
      top: 0,
      bottom: 0,
    });
  });
});
