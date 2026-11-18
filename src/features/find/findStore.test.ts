import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { useFind } from "./findStore";

const answer = (count: number, index: number) => ({ count, index, capped: false });

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  useFind.getState().closeBar();
  invoke.mockClear();
});

describe("find in page", () => {
  it("keeps the newest answer when an older search finishes last", async () => {
    let finishFirst: (value: unknown) => void = () => {};
    invoke.mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)));
    invoke.mockResolvedValueOnce(answer(2, 1));
    const slow = useFind.getState().search("a");
    await useFind.getState().search("ab");
    finishFirst(answer(40, 1));
    await slow;
    expect(useFind.getState().result).toEqual(answer(2, 1));
    expect(useFind.getState().query).toBe("ab");
  });

  it("takes the highlights down for an empty query without searching", async () => {
    useFind.setState({ result: answer(3, 2) });
    await useFind.getState().search("   ");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("find_in_page_clear", undefined);
    expect(useFind.getState().result).toBeNull();
  });

  it("steps only while there is a match, and takes the answer it gets", async () => {
    await useFind.getState().step(true);
    expect(invoke).not.toHaveBeenCalled();
    useFind.setState({ result: answer(3, 3) });
    invoke.mockResolvedValueOnce(answer(3, 1));
    await useFind.getState().step(true);
    expect(invoke).toHaveBeenCalledWith("find_in_page_step", { forward: true });
    expect(useFind.getState().result).toEqual(answer(3, 1));
  });

  it("shows a refusal in place of the count and clears the page when the bar closes", async () => {
    invoke.mockRejectedValueOnce("search text must be at most 200 characters on one line");
    await useFind.getState().search("x");
    expect(useFind.getState().error).toContain("at most 200");
    useFind.getState().openBar();
    invoke.mockClear();
    useFind.getState().closeBar();
    expect(invoke).toHaveBeenCalledWith("find_in_page_clear", undefined);
    expect(useFind.getState()).toMatchObject({ open: false, query: "", result: null });
  });
});
