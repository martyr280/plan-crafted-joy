// Pure load-sheet ordering for the warehouse print view.
//
// A truck loads last-in-first-out: the LAST delivery of the day goes in the
// nose, the FIRST delivery goes at the tail doors. So the warehouse sheet is
// the delivery sequence REVERSED, and the load order is numbered from 1 in that
// reversed direction — never re-using the delivery position, which would be
// read as the load slot and get the trailer packed backwards.
//
// Held stops are excluded: they are not going on the truck.

export type LoadSheetInputStop = {
  position: number;
  customerName?: string | null;
  orderNo?: string | null;
  pickTicketNo?: string | null;
  estPallets?: number | null;
  estCubeFt?: number | null;
  estWeightLbs?: number | null;
  hold?: boolean;
};

export type LoadSheetStop<T extends LoadSheetInputStop> = T & {
  /** 1 = loads first (deepest in the trailer). */
  loadOrder: number;
  /** The delivery-sequence position this stop keeps. */
  deliveryPosition: number;
};

export type LoadSheet<T extends LoadSheetInputStop> = {
  stops: Array<LoadSheetStop<T>>;
  totals: { stops: number; pallets: number; cubeFt: number; weightLbs: number };
};

export function buildLoadSheet<T extends LoadSheetInputStop>(stops: T[]): LoadSheet<T> {
  const live = stops.filter((s) => !s.hold).slice().sort((a, b) => a.position - b.position);
  const reversed = live.slice().reverse();
  const out = reversed.map((s, i) => ({ ...s, loadOrder: i + 1, deliveryPosition: s.position }));
  return {
    stops: out,
    totals: {
      stops: out.length,
      pallets: out.reduce((n, s) => n + (Number(s.estPallets) || 0), 0),
      cubeFt: out.reduce((n, s) => n + (Number(s.estCubeFt) || 0), 0),
      weightLbs: out.reduce((n, s) => n + (Number(s.estWeightLbs) || 0), 0),
    },
  };
}
