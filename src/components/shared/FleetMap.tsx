import { useEffect, useMemo, useRef } from "react";
import { MapContainer, TileLayer, Marker, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { formatDistanceToNow } from "date-fns";

// Fix default marker icon paths (Vite doesn't resolve Leaflet's relative URLs).
const DefaultIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});
L.Marker.prototype.options.icon = DefaultIcon;

export type FleetVehicle = {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  speedMph: number | null;
  reverseGeo: string | null;
  time: string | null;
};

function FitToVehicles({ vehicles }: { vehicles: FleetVehicle[] }) {
  const map = useMap();
  const fittedRef = useRef(false);
  useEffect(() => {
    const pts = vehicles
      .filter((v) => v.latitude != null && v.longitude != null)
      .map((v) => [v.latitude as number, v.longitude as number] as [number, number]);
    if (pts.length === 0 || fittedRef.current) return;
    map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 11 });
    fittedRef.current = true;
  }, [vehicles, map]);
  return null;
}

export function FleetMap({ vehicles }: { vehicles: FleetVehicle[] }) {
  const positioned = useMemo(
    () => vehicles.filter((v) => v.latitude != null && v.longitude != null),
    [vehicles]
  );

  const center: [number, number] =
    positioned[0] ? [positioned[0].latitude as number, positioned[0].longitude as number] : [39.5, -98.35];

  return (
    <div className="h-[420px] w-full rounded-md overflow-hidden border">
      <MapContainer center={center} zoom={4} scrollWheelZoom className="h-full w-full">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitToVehicles vehicles={positioned} />
        {positioned.map((v) => (
          <Marker key={v.id} position={[v.latitude as number, v.longitude as number]}>
            <Tooltip direction="top" offset={[0, -30]} opacity={1}>
              <div className="text-xs">
                <p className="font-semibold">{v.name}</p>
                <p>Speed: {v.speedMph != null ? `${Math.round(v.speedMph)} mph` : "—"}</p>
                <p className="text-muted-foreground">
                  {v.time ? `Updated ${formatDistanceToNow(new Date(v.time), { addSuffix: true })}` : "No timestamp"}
                </p>
                {v.reverseGeo && <p className="text-muted-foreground max-w-[220px]">{v.reverseGeo}</p>}
              </div>
            </Tooltip>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
