import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  fetchVehicleLocations,
  fetchTrips,
  fetchSafetyEvents,
  fetchDvirs,
  fetchDocuments,
  fetchDocumentById,
  samsaraHealthCheck,
} from "./samsara.server";

const windowSchema = z.object({
  hours: z.number().min(1).max(24 * 14).optional(),
});

function windowFromHours(hours = 24) {
  const endMs = Date.now();
  const startMs = endMs - hours * 3600_000;
  return { startMs, endMs };
}

export const getFleetLocations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    try {
      const vehicles = await fetchVehicleLocations();
      return { vehicles, error: null as string | null };
    } catch (e: any) {
      console.error("samsara.getFleetLocations", e);
      return { vehicles: [], error: e?.message ?? "Failed to load fleet locations" };
    }
  });

export const listTrips = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => windowSchema.parse(d))
  .handler(async ({ data }) => {
    try {
      const { startMs, endMs } = windowFromHours(data.hours ?? 24);
      const trips = await fetchTrips({ startMs, endMs });
      return { trips, error: null as string | null };
    } catch (e: any) {
      console.error("samsara.listTrips", e);
      return { trips: [], error: e?.message ?? "Failed to load trips" };
    }
  });

export const listSafetyEvents = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => windowSchema.parse(d))
  .handler(async ({ data }) => {
    try {
      const events = await fetchSafetyEvents(windowFromHours(data.hours ?? 24));
      return { events, error: null as string | null };
    } catch (e: any) {
      console.error("samsara.listSafetyEvents", e);
      return { events: [], error: e?.message ?? "Failed to load safety events" };
    }
  });

export const listDvirs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => windowSchema.parse(d))
  .handler(async ({ data }) => {
    try {
      const dvirs = await fetchDvirs(windowFromHours(data.hours ?? 72));
      return { dvirs, error: null as string | null };
    } catch (e: any) {
      console.error("samsara.listDvirs", e);
      return { dvirs: [], error: e?.message ?? "Failed to load DVIRs" };
    }
  });

export const listDocuments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => windowSchema.parse(d))
  .handler(async ({ data }) => {
    try {
      const docs = await fetchDocuments(windowFromHours(data.hours ?? 168));
      return { documents: docs, error: null as string | null };
    } catch (e: any) {
      console.error("samsara.listDocuments", e);
      return { documents: [], error: e?.message ?? "Failed to load documents" };
    }
  });

export const getDocumentForOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ documentId: z.string().min(1) }).parse(d))
  .handler(async ({ data }) => {
    try {
      const doc = await fetchDocumentById(data.documentId);
      return { document: doc, error: null as string | null };
    } catch (e: any) {
      console.error("samsara.getDocumentForOrder", e);
      return { document: null, error: e?.message ?? "Failed to load document" };
    }
  });

export const samsaraStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => samsaraHealthCheck());
