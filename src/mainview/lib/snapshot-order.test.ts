import { describe, expect, test } from "bun:test";
import { snapshotVerdict } from "./snapshot-order";

describe("snapshotVerdict", () => {
  test("an answer with no local change in between and no newer answer applied is applied", () => {
    expect(snapshotVerdict({ epochAtStart: 4, epochNow: 4, changesInFlight: 0, seq: 7, appliedSeq: 6 })).toBe("apply");
    expect(snapshotVerdict({ epochAtStart: 0, epochNow: 0, changesInFlight: 0, seq: 1, appliedSeq: 0 })).toBe("apply");
  });

  test("archiving a second card while the first card's refresh is in flight makes that answer stale", () => {
    // Refresh for card A starts at epoch 2; archiving B bumps it to 3 before the answer lands.
    expect(snapshotVerdict({ epochAtStart: 2, epochNow: 3, changesInFlight: 1, seq: 5, appliedSeq: 4 })).toBe("stale");
    // So does a change that started and finished meanwhile.
    expect(snapshotVerdict({ epochAtStart: 2, epochNow: 4, changesInFlight: 0, seq: 5, appliedSeq: 4 })).toBe("stale");
  });

  test("an answer sent and received while a slow archive is still with the server is stale", () => {
    expect(snapshotVerdict({ epochAtStart: 3, epochNow: 3, changesInFlight: 1, seq: 5, appliedSeq: 4 })).toBe("stale");
  });

  test("an older answer arriving after a newer one is dropped", () => {
    expect(snapshotVerdict({ epochAtStart: 4, epochNow: 4, changesInFlight: 0, seq: 5, appliedSeq: 6 })).toBe("late");
  });

  test("stale wins over late: the answer is asked for again either way", () => {
    expect(snapshotVerdict({ epochAtStart: 1, epochNow: 2, changesInFlight: 0, seq: 5, appliedSeq: 6 })).toBe("stale");
  });
});
